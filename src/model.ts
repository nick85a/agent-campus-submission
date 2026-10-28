import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage, type Model, type Api, type TranscriptContext, type ToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { BusinessError, type ItemState } from "./types.ts";

export function syntheticStream(model: Model<Api>, call?: { name: string; arguments: Record<string, unknown> }, error?: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (error) { message.stopReason = "error"; message.errorMessage = error; stream.push({ type: "error", reason: "error", error: message }); }
    else if (call) {
      const toolCall: ToolCall = { type: "toolCall", id: `call_${randomUUID()}`, name: call.name, arguments: call.arguments as ToolCall["arguments"] };
      message.content.push(toolCall); stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message });
    } else { message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message }); }
    stream.end();
  });
  return stream;
}

/** Deterministic model substitute, NOT evidence of real model reasoning. Reads only the transcript. */
export function mockDecision(context: TranscriptContext): { name: string; arguments: Record<string, unknown> } {
  const user = context.messages.find(m => m.role === "user");
  const userText = user ? typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("") : "{}";
  const initial = JSON.parse(userText) as { state: ItemState };
  const observations = context.messages.filter(m => m.role === "toolResult").map(m => {
    if (m.role !== "toolResult") throw new Error("unreachable");
    const text = m.content.filter(c => c.type === "text").map(c => c.text).join("");
    return { name: m.toolName, result: JSON.parse(text) as Record<string, any> };
  });
  const call = (name: string, reason: string, args: Record<string, unknown> = {}) => ({ name, arguments: { ...args, reason } });
  const last = observations.at(-1), reviewObservation = observations.findLast(o => o.name === "check_rules")?.result;
  if (!last) return initial.state.status === "canceled" ? call("finish_run", "用户已拒绝，结束该建议") : call("read_material", "先读取素材事实", { source: "catalog" });
  if (last.name === "read_material") return call("check_rules", "依据当前资料核查规则");
  if (last.name === "check_rules") {
    if (last.result.canceled || !last.result.ok || last.result.review.status === "blocked") return call("finish_run", "规则阻断或用户拒绝，结束任务");
    if (last.result.review.status === "needs_information") {
      const alreadyLooked = context.messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.name === "read_material" && c.arguments.source === "supplement"));
      return alreadyLooked ? call("finish_run", "补查后资料仍不足，等待用户补充") : call("read_material", "资料缺失，补查指定资料源", { source: "supplement" });
    }
    return call("query_slots", "审核资料足够，检查排期冲突");
  }
  if (last.name === "query_slots") {
    if (last.result.existingDraftStale) return call("finish_run", "已有草稿条件变化，阻断并请求人工处理");
    const slots = last.result.availableSlots as string[] | undefined;
    if (!slots?.length) return call("finish_run", "允许范围内没有可用时段，等待调整要求");
    const at = slots.includes(last.result.approvedAt) ? last.result.approvedAt : slots.includes(last.result.requestedAt) ? last.result.requestedAt : slots[0];
    const requirement = initial.state.input.requirement;
    const timeChange = requirement.kind === "fixed" && at !== requirement.at && at !== last.result.approvedAt;
    const risk = reviewObservation?.review.status === "needs_confirmation" && !(reviewObservation.riskAccepted && reviewObservation.riskAcceptedAt === at);
    return timeChange || risk ? call("request_confirmation", "替代时间或风险警告需要用户明确确认", { at }) : call("save_schedule_draft", "时段可用且授权满足，保存草稿", { at });
  }
  if (last.name === "request_confirmation") return call("finish_run", "已提出建议，等待用户确认");
  if (last.name === "save_schedule_draft") {
    if (last.result.ok) return call("finish_run", "保存工具返回真实草稿凭据，结束任务");
    if (last.result.code === "SAVE_FAILED" && observations.filter(o => o.name === "save_schedule_draft").length < 2) {
      const previous = context.messages.findLast(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.name === "save_schedule_draft"));
      const tool = previous?.role === "assistant" ? previous.content.find(c => c.type === "toolCall" && c.name === "save_schedule_draft") : undefined;
      return call("save_schedule_draft", "存储失败，决定进行一次有界重试", { at: tool?.type === "toolCall" ? tool.arguments.at : "" });
    }
    if (["SLOT_CONFLICT", "CONFIRMATION_REQUIRED"].includes(last.result.code)) return call("query_slots", "保存复检未通过，重新观察可用时段");
    return call("finish_run", "保存未成功，明确保留失败或阻断状态");
  }
  return call("finish_run", "结束本轮处理");
}

export function readModelSettings(env: Record<string, string | undefined>) {
  const positiveInt = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new BusinessError("MODEL_CONFIGURATION_ERROR", `${name} 必须为正整数`);
    return value;
  };
  const maxTokens = positiveInt("MODEL_MAX_TOKENS", 2048), contextWindow = positiveInt("MODEL_CONTEXT_WINDOW", 32000);
  if (maxTokens > contextWindow) throw new BusinessError("MODEL_CONFIGURATION_ERROR", "输出 Token 上限不能大于上下文容量");
  const thinking = env.MODEL_DISABLE_THINKING;
  if (thinking !== undefined && thinking !== "" && !["true", "false"].includes(thinking)) throw new BusinessError("MODEL_CONFIGURATION_ERROR", "MODEL_DISABLE_THINKING 必须为 true 或 false");
  return { maxTokens, contextWindow, disableThinking: thinking === "true" };
}

export async function createRuntime(mode: "live" | "mock", control: { decisions: number; maxDecisions: number; finished: boolean; limitReached: boolean }, onRequest: () => void) {
  if (mode === "live" && (!process.env.MODEL_BASE_URL || !process.env.MODEL_ID || !process.env.MODEL_API_KEY)) throw new BusinessError("MODEL_CONFIGURATION_ERROR", "live 模式需要 MODEL_BASE_URL、MODEL_ID、MODEL_API_KEY；可使用 --mode mock 验证离线流程");
  if (mode === "live") {
    const url = new URL(process.env.MODEL_BASE_URL!);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search) throw new BusinessError("MODEL_CONFIGURATION_ERROR", "模型地址须为不含凭据或查询参数的 HTTP(S) URL");
  }
  const settings = readModelSettings(mode === "live" ? process.env : {});
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const provider = mode === "mock" ? "scheduler-mock" : "scheduler-live";
  runtime.registerProvider(provider, {
    api: "openai-completions", baseUrl: mode === "mock" ? "http://offline.invalid/v1" : process.env.MODEL_BASE_URL,
    apiKey: mode === "mock" ? "offline-placeholder" : "$MODEL_API_KEY",
    ...(mode === "mock" ? { streamSimple: (model: Model<Api>, context: TranscriptContext) => syntheticStream(model, mockDecision(context)) } : {}),
    models: [{ id: mode === "mock" ? "deterministic-mock-v1" : process.env.MODEL_ID!, name: "Scheduler model", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: settings.contextWindow, maxTokens: settings.maxTokens, ...(settings.disableThinking ? { samplingParams: { thinking: { type: "disabled" } } } : {}), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const underlying = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model: Model<Api>, context: Parameters<typeof underlying>[1], options?: SimpleStreamOptions) => {
    if (control.finished) return syntheticStream(model);
    if (control.decisions >= control.maxDecisions || control.limitReached) { control.limitReached = true; return syntheticStream(model, undefined, "EXECUTION_LIMIT：达到执行上限，任务未完成"); }
    control.decisions++; onRequest(); return underlying(model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? settings.maxTokens, settings.maxTokens) });
  };
  const model = runtime.getModel(provider, mode === "mock" ? "deterministic-mock-v1" : process.env.MODEL_ID!)!;
  return { runtime, model };
}
