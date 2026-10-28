import { randomUUID } from "node:crypto";
import { ChatController, type ChatOptions, type ChatSnapshot, type ConfirmationAction } from "../chat/controller.ts";
import { SchedulerService } from "../service.ts";
import { hash } from "../store.ts";

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Input = { conversationId?: string; message?: string; action?: ConfirmationAction; requestId?: string };
function validate(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "请提交聊天消息。");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["conversationId", "message", "action", "requestId"].includes(k))) throw new ApiError(400, "请求包含不支持的字段。");
  if (v.conversationId !== undefined && (typeof v.conversationId !== "string" || !/^chat_[a-f0-9-]{36}$/.test(v.conversationId))) throw new ApiError(400, "会话标识无效。");
  if (v.requestId !== undefined && (typeof v.requestId !== "string" || !v.requestId.trim() || v.requestId.length > 200)) throw new ApiError(400, "消息标识无效。");
  if ((typeof v.message === "string") === Boolean(v.action)) throw new ApiError(400, "请发送一条消息或一个确认操作。");
  if (v.message !== undefined && (typeof v.message !== "string" || !v.message.trim() || v.message.length > 4000)) throw new ApiError(400, "消息不能为空或超过4000字。");
  if (v.action) {
    const a = v.action as Record<string, unknown>;
    if (typeof a !== "object" || Array.isArray(a) || Object.keys(a).some(k => !["confirmationId", "decision", "kinds"].includes(k)) || typeof a.confirmationId !== "string" || !/^confirm_[a-f0-9-]{36}$/.test(a.confirmationId) || !["accept", "reject"].includes(String(a.decision)) || a.kinds !== undefined && (!Array.isArray(a.kinds) || !a.kinds.length || a.kinds.length > 2 || new Set(a.kinds).size !== a.kinds.length || a.kinds.some(k => !["time_change", "risk_ack"].includes(k)))) throw new ApiError(400, "请明确选择当前建议及确认事项。");
    if (!v.conversationId) throw new ApiError(400, "确认操作需要已有会话。");
  }
  return v as Input;
}

/** HTTP DTO boundary: never returns model messages, raw runs, traces or tool arguments. */
export class BusinessChatApi {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, ChatController>();
  constructor(private readonly service: SchedulerService, private readonly options: ChatOptions) {
    service.store.db.exec(`CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_requests(conversation_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(conversation_id,request_id));`);
  }
  async chat(value: unknown) {
    const input = validate(value), id = input.conversationId ?? `chat_${randomUUID()}`;
    const previous = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const token = new Promise<void>(resolve => release = resolve); this.queues.set(id, token);
    await previous;
    try {
      const db = this.service.store.db;
      const row = db.prepare("SELECT owner,context FROM chat_conversations WHERE id=?").get(id);
      if (input.conversationId && (!row || row.owner !== this.service.actor)) throw new ApiError(404, "会话不存在。");
      const fingerprint = hash({ message: input.message ?? null, action: input.action ?? null });
      if (input.requestId) {
        const cached = db.prepare("SELECT fingerprint,response FROM chat_requests WHERE conversation_id=? AND request_id=?").get(id, input.requestId);
        if (cached) {
          if (cached.fingerprint !== fingerprint) throw new ApiError(409, "同一消息标识不能用于不同内容。");
          return JSON.parse(String(cached.response));
        }
      }
      let controller = this.controllers.get(id);
      if (!controller) {
        controller = new ChatController(this.service, this.options);
        if (row) controller.restore(JSON.parse(String(row.context)) as ChatSnapshot);
        this.controllers.set(id, controller);
      }
      const reply = input.action ? await controller.respondToConfirmation(input.action) : await controller.handle(input.message!);
      const view = controller.businessView();
      const itemStatus = view.materials?.[0]?.status;
      const status = reply.run?.runStatus ?? (reply.errorCode ? reply.errorCode === "EXECUTION_LIMIT" ? "incomplete" : ["CHAT_ERROR", "MODEL_CONFIGURATION_ERROR", "CHAT_MODEL_TIMEOUT", "CHAT_MODEL_UNAVAILABLE"].includes(reply.errorCode) ? "failed" : "awaiting_input" : view.confirmation || ["needs_information", "needs_confirmation"].includes(itemStatus ?? "") ? "awaiting_input" : itemStatus === "blocked" ? "blocked" : itemStatus === "save_failed" ? "failed" : ["checking", "ready", "saving"].includes(itemStatus ?? "") ? "incomplete" : itemStatus === "canceled" ? "canceled" : "completed");
      const response = { conversationId: id, message: reply.text, status, ...view };
      this.service.store.transaction(() => {
        db.prepare("INSERT INTO chat_conversations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context").run(id, this.service.actor, JSON.stringify(controller.snapshot()));
        if (input.requestId) db.prepare("INSERT INTO chat_requests VALUES(?,?,?,?)").run(id, input.requestId, fingerprint, JSON.stringify(response));
      });
      return response;
    } finally { release(); if (this.queues.get(id) === token) this.queues.delete(id); }
  }
  dispose() { for (const controller of this.controllers.values()) controller.dispose(); this.controllers.clear(); }
}
