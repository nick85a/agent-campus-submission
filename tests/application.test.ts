import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SchedulerApplication } from "../src/application/scheduler.ts";
import { fixture, request, at } from "./helpers.ts";

test("统一命令契约形成完整状态历史，审核通过与实际保存分开表达", t => {
  const f = fixture(t), app = new SchedulerApplication(f.service), s = app.execute("open_session", { input: request() });
  const target = { sessionId: s.id, materialId: "M01", channel: "douyin" };
  app.execute("read_material", { ...target, source: "catalog" }, "agent");
  app.execute("check_rules", target, "agent"); app.execute("query_slots", target, "agent");
  assert.equal(app.execute("get_schedule_state", target).fsmState, "ready");
  assert.throws(() => app.execute("finish_run", target, "agent"), { code: "UNRESOLVED_TASK" });
  const saved = app.execute("save_schedule_draft", { ...target, at: at(17) }, "agent");
  const state = app.execute("get_schedule_state", target);
  assert.equal(state.fsmState, "saved"); assert.equal(state.draft?.id, saved.draft.id); assert.deepEqual(state.waitingFor, []);
  assert.deepEqual(state.transitions.slice(-3).map(x => x.to), ["ready", "saving", "saved"]);
  assert.equal(app.execute("show_session", { sessionId: s.id }).deliveryMode, "draft_only");
});
test("模型来源不能调用用户确认、自由补充资料、开会话或重试入口", t => {
  const f = fixture(t), app = new SchedulerApplication(f.service), s = app.execute("open_session", { input: request("M01", 18) });
  const target = { sessionId: s.id, materialId: "M01", channel: "douyin" };
  const p = app.execute("request_confirmation", { ...target, at: at(19) }, "agent").proposal;
  assert.throws(() => app.execute("confirm_proposal", { ...target, proposalId: p.id, version: p.version, kinds: p.kinds, decision: "accept" }, "agent"), { code: "HOST_ACTION_REQUIRED" });
  assert.throws(() => app.execute("supplement_material", { ...target, source: "forged", fields: { rights: "granted" } }, "agent"), { code: "HOST_ACTION_REQUIRED" });
  assert.throws(() => app.execute("open_session", { input: request() }, "agent"), { code: "HOST_ACTION_REQUIRED" });
  assert.throws(() => app.execute("retry_session", { sessionId: s.id }, "agent"), { code: "HOST_ACTION_REQUIRED" });
  assert.equal(app.execute("show_session", { sessionId: s.id }).confirmations.length, 0);
  assert.equal(f.store.drafts().length, 0);
});
test("确认后只进入复检状态，时段再次冲突时不能保存或沿用同意到另一个时段", t => {
  const f = fixture(t), app = new SchedulerApplication(f.service), s = app.execute("open_session", { input: request("M01", 18) });
  const target = { sessionId: s.id, materialId: "M01", channel: "douyin" }, p = app.execute("request_confirmation", { ...target, at: at(19) }).proposal;
  app.execute("confirm_proposal", { ...target, proposalId: p.id, version: p.version, kinds: p.kinds, decision: "accept" });
  assert.equal(app.execute("get_schedule_state", target).fsmState, "checking");
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", materialId: "BUSY", at: at(19) }]));
  assert.throws(() => app.execute("save_schedule_draft", { ...target, at: at(19) }, "agent"), { code: "SLOT_CONFLICT" });
  assert.throws(() => app.execute("save_schedule_draft", { ...target, at: at(20) }, "agent"), { code: "CONFIRMATION_REQUIRED" });
  assert.equal(f.store.drafts().length, 0);
});
test("回滚后状态历史不出现虚假的保存成功，重试复用同一业务任务", t => {
  const f = fixture(t), app = new SchedulerApplication(f.service), s = app.execute("open_session", { input: request() });
  const target = { sessionId: s.id, materialId: "M01", channel: "douyin" }; f.service.saveFailures = "always";
  assert.throws(() => app.execute("save_schedule_draft", { ...target, at: at(17) }), { code: "SAVE_FAILED" });
  const state = app.execute("get_schedule_state", target);
  assert.equal(state.fsmState, "save_failed"); assert.equal(state.transitions.at(-1)?.event, "save_failed");
  assert.equal(state.transitions.some(x => x.event === "save_succeeded"), false); assert.equal(f.store.drafts().length, 0);
  assert.deepEqual(app.execute("retry_session", { sessionId: s.id }).selectedItems, [{ materialId: "M01", channel: "douyin" }]);
  f.service.saveFailures = 0; app.execute("save_schedule_draft", { ...target, at: at(17) });
  assert.equal(f.store.drafts().length, 1); assert.equal(app.execute("get_schedule_state", target).fsmState, "saved");
});
test("统一入口拒绝发布、原型属性和未知动作", t => {
  const { service } = fixture(t), app = new SchedulerApplication(service);
  for (const name of ["publish", "delete_draft", "toString", "constructor"]) assert.throws(() => app.execute(name as never, {} as never), { code: "UNKNOWN_ACTION" });
});
