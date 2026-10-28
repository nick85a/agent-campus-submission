import { SchedulerApplication, type ItemTarget } from "../application/scheduler.ts";
import { runSession, type RunOptions } from "../agent.ts";
import { SchedulerService } from "../service.ts";
import { BusinessError, type Proposal, type Requirement } from "../types.ts";
import { safeError } from "../security/redaction.ts";
import { parseChatIntent } from "./intent.ts";
import { PiConversationInterpreter, type Interpreter } from "./intake.ts";
import { randomUUID } from "node:crypto";
import { hash } from "../store.ts";
import { resolve } from "node:path";

type ScheduleState = ReturnType<SchedulerService["getState"]>;
type ShownProposal = ItemTarget & { token: string; id: string; version: number; at: string; materialVersion: number; rulesHash: string; kinds: Proposal["kinds"] };
export type ChatSnapshot = { target?: ItemTarget; shown?: ShownProposal; pendingInput?: string; piSessionFile?: string };
export type ConfirmationAction = { confirmationId: string; decision: "accept" | "reject"; kinds?: Proposal["kinds"] };
export type ChatOptions = RunOptions & { interpret?: Interpreter; intakeTraceDir?: string; piSessionDir?: string };
export type ChatReply = { text: string; errorCode?: string; exit?: boolean; run?: Awaited<ReturnType<typeof runSession>> };
export type BusinessView = { materials?: { materialId: string; channel: string; status: string; reviewStatus: string; risks: { level: string; field: string; reason: string }[]; originalRequirement: Requirement; suggestedAt: string | null; pendingConfirmations: Proposal["kinds"]; saveStatus: string; draft: { id: string; at: string } | null }[]; confirmation?: { id: string; materialId: string; channel: string; proposedAt: string; requiredApprovals: Proposal["kinds"]; risks: string[] } };
const kindNames = { time_change: "时间变更", risk_ack: "风险确认" };
const statusNames: Record<string, string> = { checking: "待检查", needs_information: "待补充信息", needs_confirmation: "待本人确认", ready: "可保存，尚未保存", saving: "保存中", saved: "草稿已保存", save_failed: "保存失败", blocked: "已阻断", canceled: "建议已拒绝" };
const reviewNames: Record<string, string> = { unchecked: "尚未审核", passed: "通过", needs_information: "资料不足", needs_confirmation: "有警告，需本人确认", blocked: "禁止处理" };
const stamp = (at: string) => at.slice(0, 16).replace("T", " ") + "（上海时间）";
export const chatHelp = `我可以帮你查找待处理素材、审核资料并安排发布草稿。你可以说：
“看看还有哪些素材没安排。”
“把 M01 放到2030年1月1日晚上六点，发抖音，帮我安排一下。”
“为什么建议改时间？”
“查看 M06”或直接输入“M06”，可继续已有任务。
需要确认时，可以选择“同意改期”“接受风险”或“拒绝当前建议”。
也可以补充素材信息、查询草稿或重试保存。默认按抖音、上海时间处理，每个整点一项；仅保存草稿。输入“退出”结束对话。`;

export class ChatController {
  private readonly app: SchedulerApplication;
  private target?: ItemTarget;
  private shown?: ShownProposal;
  private pendingInput?: string;
  private intakeCost = 0;
  private turnStarted = Date.now();
  private conversation?: PiConversationInterpreter;
  private restoredSessionFile?: string;
  constructor(private readonly service: SchedulerService, private readonly options: ChatOptions, private readonly now: () => Date = () => new Date()) { this.app = new SchedulerApplication(service); }
  snapshot(): ChatSnapshot { return { target: this.target, shown: this.shown, pendingInput: this.pendingInput, piSessionFile: this.conversation?.sessionFile ?? this.restoredSessionFile }; }
  restore(snapshot: ChatSnapshot) {
    if (snapshot.target) this.app.resolveItem(snapshot.target.sessionId, snapshot.target.materialId, snapshot.target.channel);
    this.target = snapshot.target; this.shown = snapshot.shown; this.pendingInput = snapshot.pendingInput;
    this.restoredSessionFile = snapshot.piSessionFile;
  }
  private piConversation() {
    return this.conversation ??= new PiConversationInterpreter(this.options.piSessionDir ?? resolve(".runtime/pi-chat", hash([resolve(this.service.store.path), this.service.actor]).slice(0, 24)), this.restoredSessionFile);
  }
  private async remember(userInput: unknown, reply: ChatReply) {
    if (this.options.mode === "live" && !this.options.interpret) await this.piConversation().rememberTurn(userInput, reply.text, this.businessView());
  }
  dispose() { this.conversation?.dispose(); }
  businessView(): BusinessView {
    if (!this.target || this.pendingInput) return {};
    const s = this.current(), p = s.proposal;
    if (this.shown && (!p || p.decision !== "pending" || s.requiresRecheck || p.id !== this.shown.id || p.version !== this.shown.version)) this.shown = undefined;
    return { materials: [{ materialId: s.materialId, channel: s.channel, status: s.requiresRecheck ? "blocked" : s.status, reviewStatus: s.reviewStatus, risks: s.risks.map(f => ({ level: f.level, field: f.field, reason: f.evidence })), originalRequirement: s.originalRequirement, suggestedAt: s.suggestedAt, pendingConfirmations: s.pendingConfirmations, saveStatus: s.saveStatus, draft: s.draft ? { id: s.draft.id, at: s.draft.at } : null }], ...(this.shown && p?.decision === "pending" ? { confirmation: { id: this.shown.token, materialId: s.materialId, channel: s.channel, proposedAt: p.at, requiredApprovals: s.pendingConfirmations, risks: s.risks.filter(f => f.level === "warning").map(f => f.evidence) } } : {}) };
  }
  private current() {
    if (!this.target) throw new BusinessError("CHAT_NO_SESSION", "请先安排一个素材，或用 /use SESSION_ID 恢复会话。");
    return this.app.execute("get_schedule_state", this.target);
  }
  resume(sessionId: string, materialId?: string, channel?: string): string {
    const session = this.app.execute("get_session", { sessionId });
    if (!materialId && session.items.length !== 1) throw new BusinessError("CHAT_ITEM_REQUIRED", "这是多素材会话，请用 /use SESSION_ID M01 douyin 明确当前项。");
    const id = materialId ?? session.items[0].input.materialId;
    const target = this.app.resolveItem(sessionId, id, channel);
    this.target = target; this.pendingInput = undefined; this.shown = undefined;
    return this.present(this.current());
  }
  restoredMessage() {
    if (this.pendingInput) return "已恢复上次尚未补齐的排期输入。请继续补充，或输入“取消输入”重新开始。";
    return this.target ? `已恢复上次正在处理的素材。\n${this.present(this.current())}` : undefined;
  }
  private selectMaterial(materialId: string, channel?: string, at?: string, forSupplement = false): string {
    this.shown = undefined;
    const result = this.app.execute("find_material_tasks", { materialId, channel });
    const matching = result.tasks.filter(task => !at || task.requirement.kind === "fixed" && task.requirement.at === at);
    const unfinished = matching.filter(task => !["saved", "canceled"].includes(task.status));
    const candidates = forSupplement ? unfinished : unfinished.length ? unfinished : matching;
    const current = candidates.find(task => this.target?.sessionId === task.sessionId && this.target.materialId === task.materialId && this.target.channel === task.channel);
    const selected = current ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (selected) return this.resume(selected.sessionId, materialId, selected.channel);
    this.target = undefined; this.shown = undefined; this.pendingInput = undefined;
    if (candidates.length > 1) {
      const choices = candidates.map(task => `${task.channel}，${task.requirement.kind === "fixed" ? stamp(task.requirement.at) : stamp(task.requirement.start) + " 至 " + stamp(task.requirement.end)}，${statusNames[task.status] ?? task.status}`).join("\n");
      throw new BusinessError("CHAT_MATERIAL_TASK_AMBIGUOUS", `${materialId} 有多个已有任务，请说明要继续的原定日期、时间和渠道，不会自动选择：\n${choices}`);
    }
    if (forSupplement) throw new BusinessError("CHAT_NO_MATERIAL_TASK", `${materialId} 没有可继续补资料的未完成任务。请先提供排期日期和时间；已保存或已拒绝的任务不能补资料。`);
    return `${materialId}：${result.material.title ?? "标题待补充"}。审核${reviewNames[result.review.status]}。\n${result.review.findings.map(f => f.evidence).join("；")}\n${at ? "没有找到该时间的已有任务。" : "当前没有排期任务。"}如需安排，请提供日期和整点时间。`;
  }
  private present(state: ScheduleState) {
    const r = state.originalRequirement;
    const lines = [`${state.materialId}：${statusNames[state.status] ?? state.status}。审核${reviewNames[state.reviewStatus] ?? state.reviewStatus}。`, `原定时间：${r.kind === "fixed" ? stamp(r.at) : stamp(r.start) + " 至 " + stamp(r.end)}`];
    if (state.suggestedAt) lines.push(`建议时间：${stamp(state.suggestedAt)}`);
    if (!state.draft && r.kind === "fixed" && state.suggestedAt && state.suggestedAt !== r.at && this.app.execute("describe_requested_conflicts", { sessionId: state.sessionId, materialId: state.materialId, channel: state.channel }).length) lines.push("原定时段已有其他素材安排，因此建议调整时间；调整前需要你确认。");
    const fields: Record<string, string> = { title: "标题", text: "内容", rights: "授权状态", materialId: "素材编号" };
    if (state.risks.length) lines.push("需要注意：" + state.risks.map(f => `${fields[f.field] ?? "素材资料"}：${f.evidence}`).join("；"));
    if (state.status === "needs_information") {
      const missing = state.risks.filter(f => f.level === "missing").map(f => f.field);
      const metadata = missing.filter(field => ["title", "text"].includes(field));
      if (metadata.length) lines.push(`请补充${metadata.map(field => fields[field]).join("、")}，可以直接回复字段内容，无需重复素材和排期时间。`);
      if (missing.includes("rights")) lines.push("请明确授权状态：“已授权”“未授权”或“未确认”；仅说“授权”还无法确定。");
    }
    if (state.saveStatus === "failed") lines.push("草稿保存失败，尚未产生草稿，可以重试。");
    if (state.saveStatus === "existing") lines.push("已返回原草稿，没有重复保存。");
    if (state.draft) lines.push(`草稿凭据：${state.draft.id}，${stamp(state.draft.at)}`);
    if (state.requiresRecheck) lines.push("当前依据或占用已变化，需要重新检查。");
    const p = state.proposal;
    if (p?.decision === "pending" && state.pendingConfirmations.length && !state.requiresRecheck) {
      const token = this.shown?.id === p.id && this.shown.version === p.version ? this.shown.token : `confirm_${randomUUID()}`;
      this.shown = { token, sessionId: state.sessionId, materialId: state.materialId, channel: state.channel, id: p.id, version: p.version, at: p.at, materialVersion: p.materialVersion, rulesHash: p.rulesHash, kinds: state.pendingConfirmations };
      lines.push(`需要你确认：${state.pendingConfirmations.map(k => kindNames[k]).join("、")}，建议时间为 ${stamp(p.at)}。`);
      if (state.pendingConfirmations.includes("time_change")) lines.push("确认时间变更请输入“同意改期”。");
      if (state.pendingConfirmations.includes("risk_ack")) lines.push("接受所列警告请输入“接受风险”。");
      lines.push("拒绝请输入“拒绝当前建议”。");
    } else this.shown = undefined;
    lines.push(state.draft ? "草稿已保存，尚未发布。" : "目前尚未保存或发布。");
    return lines.join("\n");
  }
  private async run(): Promise<ChatReply> {
    this.current(); const target = this.target!;
    const maxDecisions = (this.options.maxDecisions ?? 12) - this.intakeCost, maxTools = (this.options.maxTools ?? 24) - this.intakeCost, timeoutMs = (this.options.timeoutMs ?? 120000) - (Date.now() - this.turnStarted);
    if (maxDecisions < 1 || maxTools < 1 || timeoutMs < 1) throw new BusinessError("EXECUTION_LIMIT", "本次处理尚未完成，请稍后继续。");
    const run = await runSession(this.service, target.sessionId, { ...this.options, maxDecisions, maxTools, timeoutMs, selectedItems: [{ materialId: target.materialId, channel: target.channel }] });
    const text = this.present(this.current()) + (["failed", "incomplete"].includes(run.runStatus) ? "\n这次处理尚未完成，可以稍后重试或继续查询。" : "");
    return { text, run };
  }
  private async confirmationTurn(action: ConfirmationAction): Promise<ChatReply> {
    this.turnStarted = Date.now(); this.intakeCost = 0;
    try {
      if (!this.shown || this.shown.token !== action.confirmationId) throw new BusinessError("STALE_CONFIRMATION", "这项确认已过期，请先查看当前建议。");
      if (this.pendingInput) throw new BusinessError("CHAT_INFORMATION_REQUIRED", "请先补齐或取消尚未提交的新排期要求。");
      return await this.confirm({ kind: "confirm", decision: action.decision, kinds: action.kinds });
    } catch (error) { return this.failure(error); }
  }
  async respondToConfirmation(action: ConfirmationAction): Promise<ChatReply> {
    const reply = await this.confirmationTurn(action); await this.remember({ confirmation: action }, reply); return reply;
  }
  private failure(error: unknown): ChatReply {
    const code = error instanceof BusinessError ? error.code : "CHAT_ERROR";
    if (code === "CHAT_SUPPLEMENT_INFORMATION_REQUIRED" && this.target && !this.pendingInput) {
      return { text: `${safeError(error)}\n${this.present(this.current())}`, errorCode: code };
    }
    if (["CHAT_CONFIRMATION_EXPLICIT", "CHAT_CLARIFY", "CHAT_UNGROUNDED_INPUT", "UNKNOWN_CHAT_INPUT"].includes(code) && this.shown && !this.pendingInput) {
      const state = this.current();
      if (state.proposal?.id === this.shown.id && state.proposal.version === this.shown.version && state.proposal.decision === "pending" && !state.requiresRecheck) return { text: state.pendingConfirmations.length === 1 ? `你是要${state.pendingConfirmations[0] === "time_change" ? `同意把 ${state.materialId} 调整到 ${stamp(this.shown.at)}` : `接受 ${state.materialId} 当前列出的风险警告`}，复检后保存草稿吗？可以回复“同意”或“拒绝”。目前尚未保存。` : `当前建议仍保留，需要分别确认时间变更和风险。可以回复“同意改期”“接受风险”或“拒绝当前建议”。目前尚未保存。`, errorCode: code };
    }
    const messages: Record<string, string> = { CHAT_NO_SESSION: "还没有选定素材。你想查询待处理清单，还是安排某项素材？", CHAT_NO_CONFIRMATION: "当前没有可确认的建议，请先查看当前安排。", CHAT_MODEL_TIMEOUT: "这次理解请求超时了，请稍后再试。", MODEL_CONFIGURATION_ERROR: "服务暂时无法处理请求，请联系服务维护者。", CHAT_ERROR: "处理暂时未完成，请稍后再试。", EXECUTION_LIMIT: "本次处理尚未完成，请稍后继续。" };
    const allowed = /^CHAT_|^STALE_CONFIRMATION$|^INVALID_STATE$|^REVIEW_NOT_READY$|^MATERIAL_NOT_FOUND$|^INVALID_(?:DATE|TIME|CHAT_INPUT)$/;
    const text = messages[code] ?? (allowed.test(code) && error instanceof BusinessError ? safeError(error) : "处理暂时未完成，请稍后再试。");
    return { text, errorCode: code };
  }
  private async confirm(intent: Extract<ReturnType<typeof parseChatIntent>, { kind: "confirm" }>): Promise<ChatReply> {
    const shown = this.shown;
    if (!shown) throw new BusinessError("CHAT_NO_CONFIRMATION", "没有已展示且有效的待确认建议。先查看结果，不会代替你批准或发布。");
    const state = this.current(), p = state.proposal;
    if (!p || p.decision !== "pending" || state.requiresRecheck || p.id !== shown.id || p.version !== shown.version || p.at !== shown.at || p.materialVersion !== shown.materialVersion || p.rulesHash !== shown.rulesHash || JSON.stringify(state.pendingConfirmations) !== JSON.stringify(shown.kinds)) {
      this.shown = undefined;
      throw new BusinessError("STALE_CONFIRMATION", "上次展示的建议或依据已变化，未记录同意。请查看结果或重跑，再确认当前建议。");
    }
    if (intent.at && p.at.slice(11, 16) !== intent.at) throw new BusinessError("CHAT_CONFIRMATION_MISMATCH", `当前建议是 ${stamp(p.at)}，不会把对 ${intent.at} 的同意套用到该建议。`);
    let kinds = intent.kinds;
    if (intent.decision === "reject") kinds = state.pendingConfirmations;
    else if (!kinds) {
      if (state.pendingConfirmations.length !== 1) throw new BusinessError("CHAT_CONFIRMATION_SCOPE", "当前同时需要时间变更与风险确认，请分别输入“同意改期”和“接受风险”，或明确说“同意改期并接受风险”。");
      kinds = state.pendingConfirmations;
    }
    kinds = kinds.filter(k => state.pendingConfirmations.includes(k));
    if (!kinds.length) throw new BusinessError("CHAT_CONFIRMATION_SCOPE", "当前不需要这类确认，未记录其他类型的同意。");
    this.app.execute("confirm_proposal", { ...this.target!, proposalId: shown.id, version: shown.version, kinds, decision: intent.decision });
    this.shown = undefined;
    if (intent.decision === "reject" || this.current().pendingConfirmations.length) return { text: this.present(this.current()) };
    return this.run();
  }
  private explain() {
    let state = this.current();
    const lines: string[] = [];
    if (state.risks.length) lines.push(...state.risks.map(f => f.evidence));
    if (!["needs_information", "blocked", "canceled"].includes(state.status)) {
      const slots = this.app.execute("query_slots", this.target!);
      const requested = slots.slots.find(s => s.at === slots.requestedAt);
      if (requested?.conflicts.length) lines.push(`原要求 ${stamp(requested.at)} 已有其他素材安排：${requested.conflicts.map(c => c.materialId).join("、")}。`);
      if (slots.availableSlots.length) lines.push(`当前优先候选：${slots.availableSlots.slice(0, 3).map(stamp).join("、")}。`);
      else lines.push("当前允许范围内没有可用时段。");
      state = this.current();
    }
    lines.push("改动原定时间需要你同意。", this.present(state));
    return lines.join("\n");
  }
  private async handleTurn(raw: string): Promise<ChatReply> {
    this.turnStarted = Date.now(); this.intakeCost = 0;
    const text = raw.trim();
    if (!text) return { text: "" };
    try {
      if (/^\/(?:trace|json|use)\b|\.runtime|(?:查看|给我|显示|打印|获取|读取).{0,30}(?:trace|日志|系统提示|api.?key|密钥|数据库|工具调用)|(?:trace|调试).{0,10}(?:在哪|路径|怎么看)/i.test(text)) return { text: "这里可以处理素材审核、排期建议和草稿查询。你想了解哪项素材的业务结果？" };
      let intent: ReturnType<typeof parseChatIntent>;
      try {
        let local: ReturnType<typeof parseChatIntent> | undefined;
        try { local = parseChatIntent(text, this.now()); } catch { /* Free language is interpreted by the model. */ }
        if (this.options.mode === "mock" || local && ["confirm", "exit", "help", "cancel_input", "material", "publish"].includes(local.kind)) intent = local ?? parseChatIntent(text, this.now());
        else {
          this.intakeCost = 1;
          const current = this.target ? this.current() : undefined;
          intent = await (this.options.interpret ?? (context => this.piConversation().interpret(context)))({ text, pending: this.pendingInput, now: this.now(), materials: this.service.store.materials().map(m => ({ id: m.id, title: m.title })), current: current ? { materialId: current.materialId, status: current.status, missingFields: current.risks.filter(f => f.level === "missing").map(f => f.field), originalTime: current.originalRequirement.kind === "fixed" ? current.originalRequirement.at : undefined, suggestedTime: current.suggestedAt ?? undefined } : undefined, timeoutMs: Math.min(this.options.timeoutMs ?? 120000, 30000), traceDirectory: this.options.intakeTraceDir });
          if (["confirm", "use", "json"].includes(intent.kind)) throw new BusinessError("CHAT_CONFIRMATION_EXPLICIT", "请使用当前业务确认卡片，或明确输入“同意改期”“接受风险”“拒绝当前建议”。");
        }
      }
      catch (e) {
        // Ambiguous follow-ups do not erase a valid offer; new or incomplete tasks do.
        if (e instanceof BusinessError && e.code === "CHAT_INFORMATION_REQUIRED" || /安排|排期|改到|改成|\bM\d+\b/i.test(text) && !(e instanceof BusinessError && ["CHAT_CONFIRMATION_EXPLICIT", "CHAT_CLARIFY"].includes(e.code))) this.shown = undefined;
        if (this.options.mode === "mock" && this.pendingInput && e instanceof BusinessError && ["UNKNOWN_CHAT_INPUT", "CHAT_INFORMATION_REQUIRED"].includes(e.code)) {
          const merged = this.pendingInput + " " + text;
          try { intent = parseChatIntent(merged, this.now()); }
          catch (next) { if (next instanceof BusinessError && next.code === "CHAT_INFORMATION_REQUIRED") this.pendingInput = merged; throw next; }
        } else { if (e instanceof BusinessError && e.code === "CHAT_INFORMATION_REQUIRED") this.pendingInput = [this.pendingInput, text].filter(Boolean).join(" ").slice(-8000); throw e; }
      }
      if (this.pendingInput && ["confirm", "repeat", "retry", "supplement"].includes(intent.kind)) throw new BusinessError("CHAT_INFORMATION_REQUIRED", "新的排期输入尚未完整，请继续补充，或先“取消输入”并“查看结果”后处理已有建议。");
      if (["schedule", "use", "supplement"].includes(intent.kind)) this.shown = undefined;
      switch (intent.kind) {
        case "help": return { text: chatHelp };
        case "publish": return { text: "本系统仅保存排期草稿，未接入真实发布。当前没有执行发布；可以输入“查看结果”核对草稿。" };
        case "material": return { text: this.selectMaterial(intent.materialId, intent.channel, intent.at) };
        case "exit": return { text: "聊天已结束，业务进度保留在数据库中。", exit: true };
        case "cancel_input": this.pendingInput = undefined; return { text: "已取消尚未提交的排期输入；已有业务建议和草稿保持当前状态。" };
        case "pending": {
          const items = this.app.execute("list_pending", {});
          return { text: items.length ? items.map(m => `${m.materialId}：${reviewNames[m.review.status]}；${m.reason}` + (m.tasks.length ? "；" + m.tasks.map(t => statusNames[t.status]).join("、") : "")).join("\n") : "当前没有待处理素材。" };
        }
        case "use": return { text: this.resume(intent.sessionId, intent.materialId, intent.channel) };
        case "show": return { text: this.present(this.current()) };
        case "json": return { text: this.present(this.current()) };
        case "why": return { text: this.explain() };
        case "schedule": {
          const s = this.app.execute("open_session", { input: { items: [intent.item] } });
          this.target = { sessionId: s.id, materialId: intent.item.materialId, channel: intent.item.channel }; this.shown = undefined; this.pendingInput = undefined;
          return await this.run();
        }
        case "confirm": return await this.confirm(intent);
        case "supplement": {
          if (!this.target && intent.materialId) this.selectMaterial(intent.materialId, undefined, undefined, true);
          const state = this.current();
          if (intent.materialId && intent.materialId !== state.materialId) throw new BusinessError("CHAT_ITEM_MISMATCH", `当前会话素材为 ${state.materialId}；请先安排或恢复 ${intent.materialId} 的会话，再补充资料。`);
          this.app.execute("supplement_material", { ...this.target!, fields: intent.fields, source: "chat-user-input" }); this.shown = undefined;
          const reply = await this.run();
          const names: Record<string, string> = { title: "标题", text: "内容", rights: "授权状态" };
          return { ...reply, text: `已记录 ${state.materialId} 的${Object.keys(intent.fields).map(field => names[field]).join("、")}，重新审核结果如下：\n${reply.text}` };
        }
        case "repeat": return await this.run();
        case "retry": {
          const state = this.current();
          if (state.status !== "save_failed") throw new BusinessError("INVALID_STATE", "当前素材没有保存失败；多素材会话请先恢复到需要重试的素材。");
          this.app.execute("retry_session", { sessionId: state.sessionId }); return await this.run();
        }
      }
    } catch (error) { return this.failure(error); }
  }
  async handle(raw: string): Promise<ChatReply> {
    const reply = await this.handleTurn(raw); await this.remember({ message: raw }, reply); return reply;
  }
}
