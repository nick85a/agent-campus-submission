export type Requirement = { kind: "fixed"; at: string } | { kind: "window"; start: string; end: string };
export type ItemInput = { materialId: string; channel: string; requirement: Requirement };
export type RequestInput = { requestId?: string; items: ItemInput[] };
export type Material = {
  id: string; title?: string; text?: string; rights?: "granted" | "unknown" | "denied";
  version: number; sources: { source: string; fields: string[]; at: string }[];
};
export type Rules = { version: string; timezone: "Asia/Shanghai"; hours: number[]; blockedTerms: string[]; warningTerms: string[] };
export type Finding = { ruleId: string; level: "missing" | "warning" | "block"; field: string; evidence: string };
export type Review = { status: "passed" | "needs_information" | "needs_confirmation" | "blocked"; findings: Finding[]; materialVersion: number; rulesHash: string };
export type Proposal = {
  id: string; version: number; at: string; materialVersion: number; rulesHash: string;
  kinds: ("time_change" | "risk_ack")[]; warningIds: string[];
  decision: "pending" | "accepted" | "rejected" | "invalidated";
};
export type ItemStatus = "checking" | "needs_information" | "needs_confirmation" | "ready" | "saving" | "blocked" | "saved" | "save_failed" | "canceled";
export type ItemState = {
  input: ItemInput; status: ItemStatus; review?: Review; proposal?: Proposal; draftId?: string;
  suggestedAt?: string; saveStatus: "not_saved" | "saved" | "existing" | "failed"; reason?: string;
};
export type BusinessSession = {
  id: string; requestId: string; fingerprint: string; owner: string; items: ItemState[];
  version: number; createdAt: string; updatedAt: string;
};
export type Draft = { id: string; sessionId: string; materialId: string; channel: string; at: string; materialVersion: number; rulesHash: string; createdAt: string };
export type ExistingSchedule = { channel: string; at: string; materialId: string };
export type ToolResponse = { ok: boolean; code?: string; message?: string; [key: string]: unknown };
export class BusinessError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "BusinessError"; }
}
