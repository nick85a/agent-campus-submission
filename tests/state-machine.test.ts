import test from "node:test";
import assert from "node:assert/strict";
import { createItemState, transitionItem } from "../src/domain/state-machine.ts";
import { request } from "./helpers.ts";

test("未校验或没有草稿凭据不能跳到保存成功", () => {
  const item = createItemState(request().items[0]);
  assert.throws(() => transitionItem(item, "save_started"), { code: "INVALID_STATE_TRANSITION" });
  assert.throws(() => transitionItem(item, "save_succeeded"), { code: "INVALID_STATE_TRANSITION" });
  assert.throws(() => transitionItem(item, "checks_passed", "伪造就绪"), { code: "STATE_EVIDENCE_REQUIRED" });
  assert.throws(() => transitionItem(item, "draft_reused"), { code: "STATE_EVIDENCE_REQUIRED" });
  assert.equal(item.status, "checking");
});
test("确认状态迁移必须有具体建议决定，拒绝后终止不可恢复写入", () => {
  const item = createItemState(request().items[0]);
  assert.throws(() => transitionItem(item, "confirmation_requested"), { code: "STATE_EVIDENCE_REQUIRED" });
  assert.throws(() => transitionItem(item, "confirmation_accepted"), { code: "STATE_EVIDENCE_REQUIRED" });
  item.proposal = { id: "p", version: 1, at: "2030-01-01T19:00:00+08:00", materialVersion: 1, rulesHash: "r", kinds: ["time_change"], warningIds: [], decision: "pending" };
  transitionItem(item, "confirmation_requested"); item.proposal.decision = "rejected"; transitionItem(item, "confirmation_rejected");
  for (const event of ["assessment_started", "checks_passed", "save_started", "draft_reused", "material_updated"] as const) assert.throws(() => transitionItem(item, event), { code: "INVALID_STATE_TRANSITION" });
  assert.equal(item.status, "canceled");
});
test("保存必须经过 ready 与 saving，已有草稿不能重新进入新保存流程", () => {
  const item = createItemState(request().items[0]);
  item.review = { status: "passed", findings: [], materialVersion: 1, rulesHash: "r" };
  transitionItem(item, "checks_passed", "校验通过", { ready: true }); transitionItem(item, "save_started");
  assert.equal(item.status, "saving");
  assert.throws(() => transitionItem(item, "save_succeeded"), { code: "STATE_EVIDENCE_REQUIRED" });
  item.draftId = "actual-draft"; transitionItem(item, "save_succeeded", "已保存", { draftId: item.draftId });
  assert.equal(item.status, "saved"); assert.throws(() => transitionItem(item, "save_started"), { code: "INVALID_STATE_TRANSITION" });
});
