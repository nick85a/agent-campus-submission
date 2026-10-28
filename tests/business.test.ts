import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/store.ts";
import { SchedulerService, normalizeAt } from "../src/service.ts";
import { at, fixture, request } from "./helpers.ts";

test("正常保存、原始要求保持不变且返回真实草稿", t => {
  const { service, store } = fixture(t), s = service.open(request());
  assert.equal(service.checkRules(s.id, "M01", "douyin").review.status, "passed");
  assert.equal(service.querySlots(s.id, "M01", "douyin").requestedAvailable, true);
  const saved = service.saveDraft(s.id, "M01", "douyin", at(17));
  assert.equal(saved.saveStatus, "saved"); assert.equal(store.drafts()[0].id, saved.draft.id);
  assert.deepEqual(service.session(s.id).items[0].input.requirement, request().items[0].requirement);
});
test("冲突建议在本人确认前不保存，另一个用户无权确认", t => {
  const { service, store } = fixture(t), s = service.open(request("M01", 18));
  assert.equal(service.querySlots(s.id, "M01", "douyin").requestedAvailable, false);
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(19)), { code: "CONFIRMATION_REQUIRED" });
  const { proposal } = service.requestConfirmation(s.id, "M01", "douyin", at(19));
  assert.equal(store.drafts().length, 0);
  assert.throws(() => new SchedulerService(store, "someone-else").confirm(s.id, "M01", "douyin", proposal.id, proposal.version, ["time_change"], "accept"), { code: "FORBIDDEN" });
  service.confirm(s.id, "M01", "douyin", proposal.id, proposal.version, ["time_change"], "accept");
  assert.equal(service.saveDraft(s.id, "M01", "douyin", at(19)).draft.at, at(19));
  assert.equal(service.show(s.id).confirmations.length, 1);
});
test("时间同意不能替代风险同意；禁止性风险不能豁免", t => {
  const { service, store } = fixture(t), s = service.open(request("M03", 18));
  const { proposal: p } = service.requestConfirmation(s.id, "M03", "douyin", at(19));
  assert.deepEqual(p.kinds, ["time_change", "risk_ack"]);
  service.confirm(s.id, "M03", "douyin", p.id, p.version, ["time_change"], "accept");
  assert.throws(() => service.saveDraft(s.id, "M03", "douyin", at(19)), { code: "CONFIRMATION_REQUIRED" });
  service.confirm(s.id, "M03", "douyin", p.id, p.version, ["risk_ack"], "accept");
  assert.equal(service.saveDraft(s.id, "M03", "douyin", at(19)).saveStatus, "saved");
  const bad = service.open(request("M04", 17, "blocked"));
  assert.equal(service.checkRules(bad.id, "M04", "douyin").review.status, "blocked");
  assert.throws(() => service.requestConfirmation(bad.id, "M04", "douyin", at(17)), { code: "REVIEW_NOT_READY" });
  assert.throws(() => service.saveDraft(bad.id, "M04", "douyin", at(17)), { code: "REVIEW_NOT_READY" });
  assert.equal(store.drafts().length, 1);
});
test("资料补充递增版本、记录来源并使旧确认失效", t => {
  const { service } = fixture(t), s = service.open(request("M03", 18));
  const { proposal: p } = service.requestConfirmation(s.id, "M03", "douyin", at(19));
  service.confirm(s.id, "M03", "douyin", p.id, p.version, p.kinds, "accept");
  service.supplement(s.id, "M03", "douyin", { title: "已更新标题" }, "user-evidence");
  assert.equal(service.store.material("M03").version, 2);
  assert.equal(service.store.material("M03").sources.at(-1)?.source, "user-evidence");
  assert.throws(() => service.confirm(s.id, "M03", "douyin", p.id, p.version, p.kinds, "accept"), { code: "STALE_CONFIRMATION" });
  assert.throws(() => service.saveDraft(s.id, "M03", "douyin", at(19)), { code: "CONFIRMATION_REQUIRED" });
});
test("修改建议版本后旧确认失效，拒绝后不能继续写入", t => {
  const { service } = fixture(t), s = service.open(request("M01", 18));
  const p1 = service.requestConfirmation(s.id, "M01", "douyin", at(19)).proposal;
  const p2 = service.requestConfirmation(s.id, "M01", "douyin", at(20)).proposal;
  assert.equal(p2.version, p1.version + 1);
  assert.throws(() => service.confirm(s.id, "M01", "douyin", p1.id, p1.version, p1.kinds, "accept"), { code: "STALE_CONFIRMATION" });
  service.confirm(s.id, "M01", "douyin", p2.id, p2.version, p2.kinds, "reject");
  assert.equal(service.session(s.id).items[0].status, "canceled");
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(20)), { code: "INVALID_STATE" });
});
test("规则变更也会使已接受的确认失效", t => {
  const { service, dataDir } = fixture(t), s = service.open(request("M01", 18));
  const p = service.requestConfirmation(s.id, "M01", "douyin", at(19)).proposal;
  service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "accept");
  const path = resolve(dataDir, "rules.json"), rules = JSON.parse(readFileSync(path, "utf8")); rules.version = "v2"; writeFileSync(path, JSON.stringify(rules));
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(19)), { code: "CONFIRMATION_REQUIRED" });
});
test("确认之后仍复检时段，不把旧查询结果当成可保存依据", t => {
  const { service, store, dataDir } = fixture(t), s = service.open(request("M01", 18));
  const p = service.requestConfirmation(s.id, "M01", "douyin", at(19)).proposal;
  service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "accept");
  writeFileSync(resolve(dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(19), materialId: "NEW" }]));
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(19)), { code: "SLOT_CONFLICT" });
  assert.equal(store.drafts().length, 0);
});
test("已保存草稿占用时段，查询时排除自身", t => {
  const { service } = fixture(t), a = service.open(request()); service.saveDraft(a.id, "M01", "douyin", at(17));
  const b = service.open(request("M05", 17, "second"));
  assert.equal(service.querySlots(a.id, "M01", "douyin").requestedAvailable, true);
  assert.equal(service.querySlots(b.id, "M05", "douyin").requestedAvailable, false);
});
test("重复提交、重启恢复返回同一草稿，同请求不同输入报错", t => {
  const { service, store, dbPath, dataDir } = fixture(t), s = service.open(request());
  const first = service.saveDraft(s.id, "M01", "douyin", at(17));
  assert.equal(service.open(request()).id, s.id);
  assert.throws(() => service.open(request("M01", 16)), { code: "REQUEST_ID_CONFLICT" });
  const another = new Store(dbPath, dataDir);
  try { const result = new SchedulerService(another).saveDraft(s.id, "M01", "douyin", at(17)); assert.equal(result.draft.id, first.draft.id); assert.equal(result.saveStatus, "existing"); }
  finally { another.close(); }
  assert.equal(store.drafts().length, 1);
});
test("INSERT 后保存失败会真实回滚，随后重试不产生重复", t => {
  const { service, store } = fixture(t), s = service.open(request()); service.saveFailures = "always";
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(17)), { code: "SAVE_FAILED" });
  assert.equal(store.drafts().length, 0); assert.equal(service.show(s.id).items[0].saveStatus, "failed");
  service.saveFailures = 0; service.saveDraft(s.id, "M01", "douyin", at(17));
  assert.equal(store.drafts().length, 1);
});
test("资料不足不能保存，补查及人工补充后可以继续", t => {
  const { service } = fixture(t), s = service.open(request("M02"));
  assert.equal(service.checkRules(s.id, "M02", "douyin").review.status, "needs_information");
  assert.throws(() => service.saveDraft(s.id, "M02", "douyin", at(17)), { code: "REVIEW_NOT_READY" });
  service.readMaterial(s.id, "M02", "douyin", "supplement");
  assert.equal(service.checkRules(s.id, "M02", "douyin").review.status, "passed");
});
test("窗口内选择无需变更确认，窗口外拒绝保存", t => {
  const { service } = fixture(t), s = service.open({ items: [{ materialId: "M01", channel: "douyin", requirement: { kind: "window", start: at(17), end: at(19) } }] });
  assert.throws(() => service.saveDraft(s.id, "M01", "douyin", at(20)), { code: "SLOT_OUT_OF_RANGE" });
  assert.equal(service.saveDraft(s.id, "M01", "douyin", at(19)).saveStatus, "saved");
});
test("输入不能伪造确认，时间必须为有效整点，自动请求键稳定", t => {
  const { service } = fixture(t);
  assert.throws(() => service.open({ ...request(), confirmed: true } as any), { code: "INVALID_REQUEST" });
  assert.throws(() => normalizeAt("2030-02-30T17:00:00+08:00"), { code: "INVALID_TIME" });
  assert.throws(() => normalizeAt("2030-01-01T17:30:00+08:00"), { code: "INVALID_TIME" });
  assert.equal(normalizeAt("2030-01-01T09:00:00Z"), at(17));
  const a = request(); delete a.requestId;
  assert.equal(service.open(a).id, service.open(JSON.parse(JSON.stringify(a))).id);
});
test("同批次待确认建议供后续项避让，但不占用其他会话", t => {
  const { service } = fixture(t), s = service.open({ requestId: "batch", items: [request("M01", 18).items[0], request("M05", 18).items[0]] });
  service.requestConfirmation(s.id, "M01", "douyin", at(19));
  assert.equal(service.querySlots(s.id, "M05", "douyin").availableSlots.includes(at(19)), false);
  const other = service.open(request("M05", 19, "other"));
  assert.equal(service.querySlots(other.id, "M05", "douyin").requestedAvailable, true);
});
test("待处理列表区分缺资料、待确认和保存失败，成功后移出清单", t => {
  const { service } = fixture(t), s = service.open(request());
  assert.ok(service.pending().some(m => m.materialId === "M01"));
  service.saveDraft(s.id, "M01", "douyin", at(17));
  assert.equal(service.pending().some(m => m.materialId === "M01"), false);
  assert.equal(service.pending().find(m => m.materialId === "M06")?.review.status, "needs_information");
});
test("保存后重复同意幂等，但不能通过拒绝确认撤销已有草稿", t => {
  const { service, store } = fixture(t), s = service.open(request("M01", 18));
  const p = service.requestConfirmation(s.id, "M01", "douyin", at(19)).proposal;
  service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "accept");
  service.saveDraft(s.id, "M01", "douyin", at(19));
  service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "accept");
  assert.throws(() => service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "reject"), { code: "DRAFT_ALREADY_SAVED" });
  assert.throws(() => service.requestConfirmation(s.id, "M01", "douyin", at(20)), { code: "DRAFT_ALREADY_SAVED" });
  assert.equal(store.drafts().length, 1); assert.equal(service.session(s.id).items[0].status, "saved");
});
test("待处理清单能找出外部占用变化后需人工处理的已存草稿", t => {
  const { service, dataDir } = fixture(t), s = service.open(request());
  service.checkRules(s.id, "M01", "douyin"); service.saveDraft(s.id, "M01", "douyin", at(17));
  writeFileSync(resolve(dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(17), materialId: "NEW" }]));
  const task = service.pending().find(x => x.materialId === "M01")?.tasks[0];
  assert.equal(task?.status, "blocked"); assert.match(task!.reason, /人工处理/);
});
