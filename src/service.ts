import { randomUUID } from "node:crypto";
import { Store, hash, now } from "./store.ts";
import { BusinessError, type BusinessSession, type Draft, type ItemInput, type ItemState, type Material, type Proposal, type RequestInput, type Review } from "./types.ts";
import { normalizeAt, candidateSlots, slotConflicts } from "./domain/schedule-policy.ts";
import { evaluateMaterial } from "./domain/review-policy.ts";
import { createItemState, transitionItem, isUnfinished, type WorkflowEvent } from "./domain/state-machine.ts";
export { normalizeAt } from "./domain/schedule-policy.ts";

function fail(code: string, message: string): never { throw new BusinessError(code, message); }
export class SchedulerService {
  constructor(readonly store: Store, readonly actor = "local-user", public saveFailures: number | "always" = 0) {}
  open(input: RequestInput): BusinessSession {
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["requestId", "items"].includes(k)) || !Array.isArray(input.items) || !input.items.length || input.items.length > 20) fail("INVALID_REQUEST", "请求须包含 1–20 项素材，不能含确认字段或未知字段");
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200)) fail("INVALID_REQUEST", "requestId 须为非空短字符串");
    const items: ItemInput[] = input.items.map(i => {
      if (!i || typeof i !== "object" || Object.keys(i).some(k => !["materialId", "channel", "requirement"].includes(k)) || typeof i.materialId !== "string" || !i.materialId.trim() || typeof i.channel !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(i.channel)) fail("INVALID_REQUEST", "素材 ID 或渠道不合法，输入不能含 confirmed 等额外字段");
      const r = i.requirement;
      if (!r || !["fixed", "window"].includes(r.kind)) fail("INVALID_REQUIREMENT", "必须明确固定时间或允许的时间窗口");
      if (r.kind === "fixed") {
        if (Object.keys(r).some(k => !["kind", "at"].includes(k))) fail("INVALID_REQUIREMENT", "固定时间包含未知字段");
        return { materialId: i.materialId, channel: i.channel, requirement: { kind: "fixed", at: normalizeAt(r.at) } };
      }
      if (Object.keys(r).some(k => !["kind", "start", "end"].includes(k))) fail("INVALID_REQUIREMENT", "时间窗口包含未知字段");
      const start = normalizeAt(r.start), end = normalizeAt(r.end);
      if (start > end || Date.parse(end) - Date.parse(start) > 7 * 86400_000) fail("INVALID_REQUIREMENT", "窗口须为起止均包含、跨度不超过七天的有效范围");
      return { materialId: i.materialId, channel: i.channel, requirement: { kind: "window", start, end } };
    });
    if (new Set(items.map(i => `${i.materialId}:${i.channel}`)).size !== items.length) fail("DUPLICATE_ITEM", "同一批次不能重复指定同一素材和渠道");
    const fingerprint = hash(items), requestId = input.requestId ?? `auto_${fingerprint}`;
    const id = `s_${hash([this.actor, requestId]).slice(0, 24)}`;
    return this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT id FROM sessions WHERE owner=? AND request_id=?").get(this.actor, requestId);
      if (existing) {
        const s = this.store.session(String(existing.id), this.actor);
        if (s.fingerprint !== fingerprint) fail("REQUEST_ID_CONFLICT", "相同 requestId 不能用于不同输入");
        return s;
      }
      const s: BusinessSession = { id, requestId, fingerprint, owner: this.actor, version: 0, createdAt: now(), updatedAt: now(), items: items.map(createItemState) };
      this.store.insertSession(s); this.store.audit(id, "request_opened", { fingerprint }); return s;
    });
  }
  session(id: string) { return this.store.session(id, this.actor); }
  materialTasks(materialId: string, channel?: string) {
    const material = this.store.material(materialId);
    const tasks = this.store.db.prepare("SELECT payload FROM sessions WHERE owner=? ORDER BY rowid DESC").all(this.actor)
      .flatMap(row => {
        const session = JSON.parse(String(row.payload)) as BusinessSession;
        return session.items.filter(item => item.input.materialId === materialId && (!channel || item.input.channel === channel))
          .map(item => ({ sessionId: session.id, materialId, channel: item.input.channel, status: item.status, requirement: item.input.requirement }));
      });
    return { material, review: this.review(material), tasks };
  }
  item(s: BusinessSession, materialId: string, channel?: string): ItemState {
    const items = s.items.filter(i => i.input.materialId === materialId && (!channel || i.input.channel === channel));
    if (items.length !== 1) fail("ITEM_NOT_FOUND", "须明确当前会话中的素材和渠道");
    return items[0];
  }
  private update<T>(id: string, materialId: string, channel: string, fn: (s: BusinessSession, i: ItemState) => T): T {
    return this.store.transaction(() => { const s = this.session(id); const item = this.item(s, materialId, channel); const result = fn(s, item); this.store.putSession(s); return result; });
  }
  private move(s: BusinessSession, item: ItemState, event: WorkflowEvent, reason?: string, evidence?: { ready?: boolean; draftId?: string }) {
    const transition = transitionItem(item, event, reason, evidence);
    this.store.audit(s.id, "state_transition", { materialId: item.input.materialId, channel: item.input.channel, actor: this.actor, ...transition });
  }
  readMaterial(id: string, materialId: string, channel: string, source: "catalog" | "supplement" = "catalog") {
    this.item(this.session(id), materialId, channel);
    try { this.store.material(materialId); } catch (e) {
      if (!(e instanceof BusinessError) || e.code !== "MATERIAL_NOT_FOUND") throw e;
      this.update(id, materialId, channel, (s, item) => { if (item.status !== "canceled") this.move(s, item, "information_required", `素材 ${materialId} 不存在，请核对素材 ID`); });
      return { found: false, missingMaterial: true };
    }
    if (source === "supplement") {
      const fields = this.store.supplementSource(materialId);
      if (!fields) return { found: false, source: "synthetic-supplement", material: this.store.material(materialId) };
      this.supplement(id, materialId, channel, fields, "synthetic-supplement");
    }
    return { found: true, material: this.store.material(materialId) };
  }
  supplement(id: string, materialId: string, channel: string, fields: Record<string, unknown>, source: string) {
    if (!source || typeof source !== "string" || source.length > 500 || !fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) fail("INVALID_SUPPLEMENT", "补充信息必须有字段和可追溯来源");
    for (const [key, value] of Object.entries(fields)) {
      if (!["title", "text", "rights"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 10000) fail("INVALID_SUPPLEMENT", "只允许补充 title、text、rights 字段且值须为非空字符串");
      if (key === "rights" && !["granted", "unknown", "denied"].includes(value)) fail("INVALID_SUPPLEMENT", "授权状态不合法");
    }
    return this.store.transaction(() => {
      const s = this.session(id), item = this.item(s, materialId, channel);
      if (["saved", "canceled"].includes(item.status) || this.store.draftFor(id, materialId, channel)) fail("INVALID_STATE", "已保存或已拒绝任务不接受资料补充");
      const material = this.store.material(materialId);
      const changed = Object.entries(fields).some(([k, v]) => (material as unknown as Record<string, unknown>)[k] !== v);
      if (!changed) return material;
      Object.assign(material, fields); material.version++; material.sources.push({ source, fields: Object.keys(fields), at: now() });
      this.store.putMaterial(material);
      // All sessions referring to this material lose obsolete evidence and consent.
      const rows = this.store.db.prepare("SELECT id FROM sessions").all();
      for (const row of rows) {
        const current = this.store.session(String(row.id)); let touched = false;
        for (const target of current.items.filter(i => i.input.materialId === materialId)) {
          if (target.proposal) target.proposal.decision = "invalidated";
          if (target.status !== "saved" && target.status !== "canceled") { this.move(current, target, "material_updated", "资料已更新，等待重新审核"); target.review = undefined; }
          touched = true;
        }
        if (touched) this.store.putSession(current);
      }
      this.store.audit(id, "material_supplemented", { materialId, version: material.version, source, fields: Object.keys(fields), actor: this.actor });
      return material;
    });
  }
  review(material: Material): Review { return evaluateMaterial(material, this.store.rules()); }
  private validProposal(item: ItemState, review: Review) {
    return item.proposal && item.proposal.materialVersion === review.materialVersion && item.proposal.rulesHash === review.rulesHash && !["invalidated", "rejected"].includes(item.proposal.decision) ? item.proposal : undefined;
  }
  private consent(id: string, item: ItemState, review: Review, at: string, kind: Proposal["kinds"][number]) {
    const p = this.validProposal(item, review);
    return Boolean(p && p.at === at && p.kinds.includes(kind) && this.store.db.prepare("SELECT id FROM confirmations WHERE session_id=? AND proposal_id=? AND proposal_version=? AND kind=? AND decision='accept' AND actor=?").get(id, p.id, p.version, kind, this.actor));
  }
  checkRules(id: string, materialId: string, channel: string) {
    return this.update(id, materialId, channel, (s, item) => {
      let review: Review;
      try { review = this.review(this.store.material(materialId)); }
      catch (e) {
        if (!(e instanceof BusinessError) || e.code !== "MATERIAL_NOT_FOUND") throw e;
        review = { status: "needs_information", materialVersion: 0, rulesHash: hash(this.store.rules()), findings: [{ ruleId: "MATERIAL_NOT_FOUND", field: "materialId", level: "missing", evidence: "素材不存在，请核对 ID" }] };
      }
      item.review = review;
      if (item.status === "canceled") return { review, canceled: true };
      if (item.proposal && !this.validProposal(item, review)) item.proposal.decision = "invalidated";
      const reason = review.findings.map(f => f.evidence).join("；") || "审核通过，等待选择并校验时段";
      if (item.status === "saved") {
        const draft = this.store.draftFor(id, materialId, channel);
        if (!draft || draft.materialVersion !== review.materialVersion || draft.rulesHash !== review.rulesHash || ["blocked", "needs_information"].includes(review.status)) this.move(s, item, "blocked", "DRAFT_STALE：已存草稿的审核依据变化，请人工处理");
      } else this.move(s, item, review.status === "blocked" ? "blocked" : review.status === "needs_information" ? "information_required" : "assessment_started", reason);
      const p = this.validProposal(item, review), riskAccepted = Boolean(p && this.consent(id, item, review, p.at, "risk_ack"));
      return { review, approvedAt: p?.decision === "accepted" ? p.at : undefined, riskAccepted, riskAcceptedAt: riskAccepted ? p?.at : undefined };
    });
  }
  private candidates(input: ItemInput): string[] { return candidateSlots(input, this.store.rules().hours); }
  private conflicts(s: BusinessSession, item: ItemState, at: string) { return slotConflicts(s, item, at, this.store.schedules(), this.store.drafts()); }
  requestedConflicts(id: string, materialId: string, channel: string) {
    const s = this.session(id), item = this.item(s, materialId, channel), r = item.input.requirement;
    return r.kind === "fixed" ? this.conflicts(s, item, r.at) : [];
  }
  querySlots(id: string, materialId: string, channel: string) {
    return this.update(id, materialId, channel, (s, item) => {
      const requestedAt = item.input.requirement.kind === "fixed" ? item.input.requirement.at : undefined;
      const all = this.candidates(item.input), slots = all.map(at => ({ at, conflicts: this.conflicts(s, item, at) }));
      const availableSlots = slots.filter(x => !x.conflicts.length).map(x => x.at);
      const review = this.review(this.store.material(materialId)), p = this.validProposal(item, review);
      const existing = this.store.draftFor(id, materialId, channel);
      const existingDraftStale = Boolean(existing && (existing.materialVersion !== review.materialVersion || existing.rulesHash !== review.rulesHash || this.conflicts(s, item, existing.at).length));
      if (existingDraftStale) { this.move(s, item, "blocked", "DRAFT_STALE：已有草稿的条件或占用已变化，本期不自动修改，请人工处理"); item.saveStatus = "existing"; }
      if (!availableSlots.length && !["blocked", "canceled"].includes(item.status)) this.move(s, item, "information_required", "NO_AVAILABLE_SLOT：允许范围内无可用时段，请调整要求");
      const approvedAt = p?.decision === "accepted" ? p.at : undefined;
      const readyAt = approvedAt && availableSlots.includes(approvedAt) ? approvedAt : requestedAt && availableSlots.includes(requestedAt) ? requestedAt : item.input.requirement.kind === "window" ? availableSlots[0] : undefined;
      const authorizationsSatisfied = readyAt && (!review.findings.some(f => f.level === "warning") || this.consent(id, item, review, readyAt, "risk_ack"));
      if (readyAt && authorizationsSatisfied && !["saved", "blocked", "canceled"].includes(item.status) && !["blocked", "needs_information"].includes(review.status)) {
        item.review = review; this.move(s, item, "checks_passed", "存在符合要求、授权与占用校验的可保存时段", { ready: true });
      }
      return { requestedAt, requestedAvailable: requestedAt ? availableSlots.includes(requestedAt) : undefined, approvedAt, availableSlots, slots, existingDraftStale, fsmState: item.status };
    });
  }
  requestConfirmation(id: string, materialId: string, channel: string, rawAt: string) {
    const at = normalizeAt(rawAt);
    return this.update(id, materialId, channel, (s, item) => {
      if (item.status === "canceled") fail("INVALID_STATE", "用户已拒绝，不能继续该任务");
      if (this.store.draftFor(id, materialId, channel)) fail("DRAFT_ALREADY_SAVED", "本期不修改已保存草稿，不能创建新的改排建议");
      const review = this.review(this.store.material(materialId)); item.review = review;
      if (["blocked", "needs_information"].includes(review.status)) fail("REVIEW_NOT_READY", "资料不足或禁止性风险不能通过确认绕过");
      if (!this.candidates(item.input).includes(at) || this.conflicts(s, item, at).length) fail("SLOT_CONFLICT", "建议时段不可用，请重新查询");
      const kinds: Proposal["kinds"] = [];
      if (item.input.requirement.kind === "fixed" && at !== item.input.requirement.at) kinds.push("time_change");
      if (review.findings.some(f => f.level === "warning")) kinds.push("risk_ack");
      if (!kinds.length) fail("CONFIRMATION_NOT_NEEDED", "无需额外确认，可按原要求保存草稿");
      const existing = this.validProposal(item, review);
      if (existing?.at === at && hash(existing.kinds) === hash(kinds)) { this.move(s, item, existing.decision === "accepted" ? "confirmation_accepted" : "confirmation_requested", existing.decision === "accepted" ? "建议已确认，等待复检" : "等待本人确认该建议"); return { proposal: existing }; }
      const p: Proposal = { id: `p_${randomUUID()}`, version: (item.proposal?.version ?? 0) + 1, at, materialVersion: review.materialVersion, rulesHash: review.rulesHash, kinds, warningIds: review.findings.filter(f => f.level === "warning").map(f => f.ruleId), decision: "pending" };
      item.proposal = p; item.suggestedAt = at; this.move(s, item, "confirmation_requested", `需要本人确认：${kinds.join(", ")}`);
      this.store.audit(id, "confirmation_requested", { materialId, proposal: p }); return { proposal: p };
    });
  }
  confirm(id: string, materialId: string, channel: string, proposalId: string, version: number, kinds: Proposal["kinds"], decision: "accept" | "reject") {
    return this.update(id, materialId, channel, (s, item) => {
      const review = this.review(this.store.material(materialId)), p = this.validProposal(item, review);
      if (!p || p.id !== proposalId || p.version !== version || p.decision === "rejected") fail("STALE_CONFIRMATION", "确认对象或版本已过期，请重新评估");
      if (!["accept", "reject"].includes(decision) || !Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || kinds.some(k => !p.kinds.includes(k))) fail("INVALID_CONFIRMATION", "必须明确确认类型：time_change 或 risk_ack");
      if (this.store.draftFor(id, materialId, channel)) {
        if (decision === "accept" && kinds.every(k => this.consent(id, item, review, p.at, k))) return { proposal: p, status: item.status };
        fail("DRAFT_ALREADY_SAVED", "本期不撤销或修改已保存草稿的确认");
      }
      for (const kind of kinds) {
        if (!this.store.db.prepare("SELECT id FROM confirmations WHERE proposal_id=? AND kind=? AND decision=? AND actor=?").get(p.id, kind, decision, this.actor)) this.store.db.prepare("INSERT INTO confirmations VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, materialId, p.id, p.version, kind, decision, this.actor, now());
      }
      if (decision === "reject") { p.decision = "rejected"; this.move(s, item, "confirmation_rejected", "用户拒绝该建议，任务已终止"); }
      else {
        const accepted = p.kinds.every(k => this.consent(id, item, review, p.at, k));
        p.decision = accepted ? "accepted" : "pending";
        this.move(s, item, accepted ? "confirmation_accepted" : "confirmation_requested", accepted ? "用户已确认，待重新检查并保存草稿" : "仍有未确认事项");
      }
      this.store.audit(id, "user_confirmation", { materialId, proposalId, version, kinds, decision, actor: this.actor });
      return { proposal: p, status: item.status };
    });
  }
  saveDraft(id: string, materialId: string, channel: string, rawAt: string) {
    const at = normalizeAt(rawAt);
    try {
      return this.update(id, materialId, channel, (s, item) => {
        if (item.status === "canceled") fail("INVALID_STATE", "任务已被用户拒绝");
        const review = this.review(this.store.material(materialId)); item.review = review;
        if (["blocked", "needs_information"].includes(review.status)) fail("REVIEW_NOT_READY", "审核未通过，不能保存草稿");
        if (!this.candidates(item.input).includes(at)) fail("SLOT_OUT_OF_RANGE", "时段不在允许的排期范围内");
        if (item.input.requirement.kind === "fixed" && at !== item.input.requirement.at && !this.consent(id, item, review, at, "time_change")) fail("CONFIRMATION_REQUIRED", "改变硬性时间必须先取得用户同意");
        if (review.findings.some(f => f.level === "warning") && !this.consent(id, item, review, at, "risk_ack")) fail("CONFIRMATION_REQUIRED", "风险警告必须单独取得用户确认");
        if (this.conflicts(s, item, at).length) fail("SLOT_CONFLICT", "保存前复检发现时段冲突，未保存");
        const existing = this.store.draftFor(id, materialId, channel);
        if (existing) {
          if (existing.at !== at || existing.materialVersion !== review.materialVersion || existing.rulesHash !== review.rulesHash) fail("DRAFT_STALE", "已有草稿与当前条件不一致；本期仅支持查看，请人工处理");
          item.saveStatus = "existing"; item.draftId = existing.id; item.suggestedAt = at;
          this.move(s, item, "draft_reused", "重复提交，返回已有草稿", { draftId: existing.id });
          if (item.proposal && item.proposal.at !== at) item.proposal.decision = "invalidated";
          return { draft: existing, saveStatus: "existing" };
        }
        this.move(s, item, "checks_passed", "保存前审核、授权和时段复检通过", { ready: true });
        this.move(s, item, "save_started", "开始事务保存排期草稿");
        const draft: Draft = { id: `d_${randomUUID()}`, sessionId: id, materialId, channel, at, materialVersion: review.materialVersion, rulesHash: review.rulesHash, createdAt: now() };
        this.store.db.prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?)").run(draft.id, id, materialId, channel, at, JSON.stringify(draft));
        // Failure occurs AFTER INSERT to exercise actual transaction rollback.
        if (this.saveFailures === "always" || this.saveFailures > 0) { if (typeof this.saveFailures === "number") this.saveFailures--; fail("SAVE_FAILED", "模拟草稿存储失败，事务已回滚"); }
        item.saveStatus = "saved"; item.draftId = draft.id; item.suggestedAt = at;
        this.move(s, item, "save_succeeded", "草稿已保存；未执行发布", { draftId: draft.id });
        if (item.proposal && item.proposal.at !== at) item.proposal.decision = "invalidated";
        this.store.audit(id, "draft_saved", { draftId: draft.id, materialId, at }); return { draft, saveStatus: "saved" };
      });
    } catch (error) {
      if (error instanceof BusinessError && error.code === "DRAFT_STALE") {
        this.update(id, materialId, channel, (s, item) => { this.move(s, item, "blocked", error.message); item.saveStatus = "existing"; });
      }
      if (error instanceof BusinessError && error.code !== "SAVE_FAILED") throw error;
      this.update(id, materialId, channel, (s, item) => { this.move(s, item, "save_failed", "草稿保存失败，未产生新记录；可使用 retry 重试"); item.saveStatus = "failed"; this.store.audit(id, "draft_save_failed", { materialId }); });
      throw new BusinessError("SAVE_FAILED", "草稿保存失败，事务已回滚；可重试");
    }
  }
  finish(id: string, materialId: string, channel: string) {
    let s = this.session(id), item = this.item(s, materialId, channel);
    const actual = this.store.draftFor(id, materialId, channel);
    if (actual) {
      const review = this.review(this.store.material(materialId));
      if (actual.materialVersion !== review.materialVersion || actual.rulesHash !== review.rulesHash || this.conflicts(s, item, actual.at).length) {
        this.update(id, materialId, channel, (s, i) => { this.move(s, i, "blocked", "DRAFT_STALE：已有草稿的资料、规则或占用变化，需人工处理"); i.saveStatus = "existing"; });
        s = this.session(id); item = this.item(s, materialId, channel);
      }
    }
    if (isUnfinished(item.status)) fail("UNRESOLVED_TASK", "任务尚未形成可核实结论，不能宣称完成");
    return this.resultItem(s, item);
  }
  private resultItem(s: BusinessSession, item: ItemState) {
    const actual = this.store.draftFor(s.id, item.input.materialId, item.input.channel);
    let currentReview = item.review;
    try { currentReview = this.review(this.store.material(item.input.materialId)); } catch { /* Unknown ID is shown through its stored missing-information result. */ }
    const current = currentReview ? this.validProposal(item, currentReview) : undefined;
    const proposal = item.proposal && !current ? { ...item.proposal, decision: item.proposal.decision === "rejected" ? "rejected" as const : "invalidated" as const } : item.proposal;
    const currentConflicts = actual ? this.conflicts(s, item, actual.at) : [];
    const requiresRecheck = currentConflicts.length > 0 || Boolean(currentReview && ((item.review && (item.review.materialVersion !== currentReview.materialVersion || item.review.rulesHash !== currentReview.rulesHash)) || (actual && (actual.materialVersion !== currentReview.materialVersion || actual.rulesHash !== currentReview.rulesHash))));
    return { materialId: item.input.materialId, channel: item.input.channel, status: item.status, fsmState: item.status, reviewStatus: item.review?.status ?? "unchecked", risks: item.review?.findings ?? [], originalRequirement: item.input.requirement, suggestedAt: item.suggestedAt ?? null, approvedAt: current?.decision === "accepted" ? current.at : null, pendingConfirmations: current?.decision === "pending" ? current.kinds.filter(k => !currentReview || !this.consent(s.id, item, currentReview, current.at, k)) : [], proposal: proposal ?? null, saveStatus: actual ? (item.saveStatus === "saved" ? "saved" : "existing") : item.saveStatus === "failed" ? "failed" : "not_saved", draft: actual ?? null, currentConflicts, requiresRecheck, reason: item.reason ?? null };
  }
  show(id: string) {
    const s = this.session(id);
    return { sessionId: s.id, requestId: s.requestId, owner: s.owner, version: s.version, deliveryMode: "draft_only", items: s.items.map(i => this.resultItem(s, i)), transitions: this.store.transitions(id), confirmations: this.store.db.prepare("SELECT proposal_id,proposal_version,kind,decision,actor,at FROM confirmations WHERE session_id=? ORDER BY at,id").all(id) };
  }
  getState(id: string, materialId: string, channel?: string) {
    const s = this.session(id), item = this.item(s, materialId, channel), result = this.resultItem(s, item);
    const waitingFor = result.risks.filter(f => f.level === "missing").map(f => f.field);
    if (item.reason?.startsWith("NO_AVAILABLE_SLOT")) waitingFor.push("timeRequirement");
    return { sessionId: s.id, sessionVersion: s.version, ...result, waitingFor: [...new Set(waitingFor)], transitions: this.store.transitions(id, materialId, item.input.channel) };
  }
  pending() {
    const sessions = this.store.db.prepare("SELECT id FROM sessions WHERE owner=? ORDER BY id").all(this.actor).map(r => this.session(String(r.id)));
    return this.store.materials().flatMap(m => {
      const tasks = sessions.flatMap(s => s.items.filter(i => i.input.materialId === m.id).map(i => {
        const result = this.resultItem(s, i), stale = i.status === "saved" && result.requiresRecheck;
        return { sessionId: s.id, channel: i.input.channel, status: stale ? "blocked" as const : i.status, reason: stale ? "已存草稿条件变化，需人工处理" : i.reason ?? "尚未完成排期" };
      }));
      const waiting = tasks.filter(t => t.status !== "saved" && t.status !== "canceled");
      if (waiting.length) return [{ materialId: m.id, review: this.review(m), tasks: waiting, reason: "有待处理任务" }];
      if (this.store.drafts().some(d => d.materialId === m.id && this.store.session(d.sessionId).owner === this.actor)) return [];
      return [{ materialId: m.id, review: this.review(m), tasks: [], reason: tasks.some(t => t.status === "canceled") ? "建议已拒绝，素材尚未排期" : "尚未排期" }];
    });
  }
}
