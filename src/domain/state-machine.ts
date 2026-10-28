import { BusinessError, type ItemInput, type ItemState, type ItemStatus } from "../types.ts";

export type WorkflowEvent = "assessment_started" | "information_required" | "confirmation_requested" | "confirmation_accepted" | "confirmation_rejected" | "material_updated" | "checks_passed" | "save_started" | "save_succeeded" | "save_failed" | "draft_reused" | "blocked";
const active: readonly ItemStatus[] = ["checking", "needs_information", "needs_confirmation", "ready", "save_failed", "blocked"];
const transitions: Record<WorkflowEvent, { from: readonly ItemStatus[]; to: ItemStatus }> = {
  assessment_started: { from: active, to: "checking" },
  information_required: { from: active, to: "needs_information" },
  confirmation_requested: { from: active, to: "needs_confirmation" },
  confirmation_accepted: { from: ["needs_confirmation", "checking", "ready", "save_failed"], to: "checking" },
  confirmation_rejected: { from: ["needs_confirmation", "checking", "ready", "save_failed"], to: "canceled" },
  material_updated: { from: active, to: "checking" },
  checks_passed: { from: active, to: "ready" },
  save_started: { from: ["ready"], to: "saving" },
  save_succeeded: { from: ["saving"], to: "saved" },
  // The transaction rolled back to its pre-save state before failure is persisted.
  save_failed: { from: [...active, "saving"], to: "save_failed" },
  draft_reused: { from: [...active, "saved"], to: "saved" },
  blocked: { from: [...active, "saved"], to: "blocked" },
};

export function createItemState(input: ItemInput): ItemState { return { input, status: "checking", saveStatus: "not_saved" }; }
export function canTransition(from: ItemStatus, event: WorkflowEvent): boolean { return transitions[event].from.includes(from); }

/** Only authority for item status mutation. Evidence is supplied by validated business code. */
export function transitionItem(item: ItemState, event: WorkflowEvent, reason?: string, evidence?: { ready?: boolean; draftId?: string }) {
  const rule = transitions[event], from = item.status;
  if (!rule || !canTransition(from, event)) throw new BusinessError("INVALID_STATE_TRANSITION", `不允许从 ${from} 执行 ${event}`);
  if (event === "checks_passed" && (evidence?.ready !== true || !item.review || ["blocked", "needs_information"].includes(item.review.status))) throw new BusinessError("STATE_EVIDENCE_REQUIRED", "进入待保存状态需要审核、授权和时段校验凭据");
  if (event === "confirmation_requested" && (!item.proposal || item.proposal.decision !== "pending")) throw new BusinessError("STATE_EVIDENCE_REQUIRED", "等待确认必须对应具体待确认建议");
  if (event === "confirmation_accepted" && item.proposal?.decision !== "accepted") throw new BusinessError("STATE_EVIDENCE_REQUIRED", "必须先完成具体建议的全部用户确认");
  if (event === "confirmation_rejected" && item.proposal?.decision !== "rejected") throw new BusinessError("STATE_EVIDENCE_REQUIRED", "拒绝必须对应用户的明确决定");
  if (["save_succeeded", "draft_reused"].includes(event) && (!evidence?.draftId || item.draftId !== evidence.draftId)) throw new BusinessError("STATE_EVIDENCE_REQUIRED", "保存成功必须有真实草稿凭据");
  item.status = rule.to;
  if (reason !== undefined) item.reason = reason;
  return { from, to: rule.to, event, reason: reason ?? null };
}

export function isUnfinished(status: ItemStatus) { return ["checking", "ready", "saving"].includes(status); }
