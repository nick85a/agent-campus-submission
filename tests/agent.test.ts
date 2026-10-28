import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSession } from "../src/agent.ts";
import { at, fixture, request } from "./helpers.ts";

test("真正通过 Pi 执行离线工具循环，正常、缺失、风险和冲突走不同路径", async t => {
  const f = fixture(t);
  for (const [id, material, hour, expected] of [["normal", "M01", 17, "saved"], ["missing", "M06", 16, "needs_information"], ["warning", "M03", 15, "needs_confirmation"], ["conflict", "M05", 18, "needs_confirmation"], ["blocked", "M04", 14, "blocked"], ["supplement", "M02", 13, "saved"]] as const) {
    const s = f.service.open(request(material, hour, id)), tracePath = resolve(f.dir, `${id}.jsonl`);
    const result = await runSession(f.service, s.id, { mode: "mock", tracePath });
    assert.equal(result.items[0].status, expected, JSON.stringify(result));
    assert.equal(result.error, null); assert.ok(result.mockBoundary);
    const calls = readFileSync(tracePath, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.event === "tool_start").map(e => e.tool);
    assert.equal(calls[0], "read_material"); assert.equal(calls.at(-1), "finish_run");
    if (id === "normal") assert.ok(calls.includes("save_schedule_draft"));
    if (id === "conflict") { assert.ok(calls.includes("request_confirmation")); assert.equal(calls.includes("save_schedule_draft"), false); assert.equal(result.items[0].suggestedAt, at(19)); }
    if (id === "supplement") assert.equal(calls.filter(n => n === "read_material").length, 2);
  }
});
test("Pi 在确认后恢复，并对变动占用重新决策而不是固定选择 19 点", async t => {
  const f = fixture(t), s = f.service.open(request("M01", 18));
  const first = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "first.jsonl") });
  const p = first.items[0].proposal!; assert.equal(p.at, at(19));
  f.service.confirm(s.id, "M01", "douyin", p.id, p.version, p.kinds, "accept");
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(18), materialId: "BUSY18" }, { channel: "douyin", at: at(19), materialId: "BUSY19" }]));
  const next = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "next.jsonl") });
  assert.equal(next.items[0].suggestedAt, at(20)); assert.equal(next.items[0].saveStatus, "not_saved");
  const p2 = next.items[0].proposal!; f.service.confirm(s.id, "M01", "douyin", p2.id, p2.version, p2.kinds, "accept");
  const final = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "final.jsonl") });
  assert.equal(final.items[0].draft?.at, at(20)); assert.equal(f.store.drafts().length, 1);
});
test("占用由 18 改到 19 后，重复输入回到原要求且清除旧待确认项", async t => {
  const f = fixture(t), s = f.service.open(request("M01", 18));
  await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "one.jsonl") });
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(19), materialId: "BUSY19" }]));
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "two.jsonl") });
  assert.equal(result.items[0].draft?.at, at(18)); assert.deepEqual(result.items[0].pendingConfirmations, []);
});
test("模型观察保存失败后有界重试，仍失败时返回 failed，重跑后只存一份", async t => {
  const f = fixture(t), s = f.service.open(request()); f.service.saveFailures = "always";
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "failed.jsonl") });
  assert.equal(result.runStatus, "failed"); assert.equal(result.items[0].saveStatus, "failed"); assert.equal(f.store.drafts().length, 0);
  const trace = readFileSync(result.tracePath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(trace.filter(e => e.event === "tool_start" && e.tool === "save_schedule_draft").length, 2);
  f.service.saveFailures = 0;
  const retry = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "retry.jsonl") });
  assert.equal(retry.runStatus, "completed"); assert.equal(f.store.drafts().length, 1);
});
test("模型决策与工具上限都由宿主强制执行并返回 incomplete", async t => {
  const f = fixture(t), s = f.service.open(request());
  const a = await runSession(f.service, s.id, { mode: "mock", maxDecisions: 2, tracePath: resolve(f.dir, "decision-limit.jsonl") });
  assert.equal(a.runStatus, "incomplete"); assert.equal(a.decisions, 2); assert.equal(f.store.drafts().length, 0);
  const b = await runSession(f.service, s.id, { mode: "mock", maxTools: 2, tracePath: resolve(f.dir, "tool-limit.jsonl") });
  assert.equal(b.runStatus, "incomplete"); assert.equal(b.toolCalls, 2);
});
test("未知素材和无可用时段明确等待输入，不虚构资料或越界", async t => {
  const f = fixture(t), s = f.service.open(request("UNKNOWN"));
  const unknown = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "unknown.jsonl") });
  assert.equal(unknown.items[0].status, "needs_information"); assert.equal(unknown.runStatus, "awaiting_input");
  const all = f.store.rules().hours.map(h => ({ channel: "douyin", at: at(h), materialId: `BUSY${h}` }));
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify(all));
  const noSlots = f.service.open(request("M01", 18, "no-slots"));
  const output = await runSession(f.service, noSlots.id, { mode: "mock", tracePath: resolve(f.dir, "no-slots.jsonl") });
  assert.equal(output.runStatus, "awaiting_input"); assert.match(output.items[0].reason!, /NO_AVAILABLE_SLOT/); assert.equal(f.store.drafts().length, 0);
});
test("大批次预算耗尽后重跑可以继续，已有草稿复检后复用", async t => {
  const f = fixture(t), s = f.service.open({ requestId: "large-batch", items: [request("M01", 17).items[0], request("M05", 16).items[0], request("M02", 15).items[0]] });
  const first = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "partial.jsonl") });
  assert.equal(first.runStatus, "incomplete"); assert.equal(f.store.drafts().length, 2);
  const second = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "resumed.jsonl") });
  assert.equal(second.runStatus, "completed", JSON.stringify(second)); assert.equal(f.store.drafts().length, 3);
});
test("已有草稿遭遇外部占用后重跑明确阻断，并保留原草稿供人工处理", async t => {
  const f = fixture(t), s = f.service.open(request());
  await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "saved.jsonl") });
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(17), materialId: "NEW" }]));
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "stale.jsonl") });
  assert.equal(result.runStatus, "blocked"); assert.equal(result.items[0].saveStatus, "existing"); assert.equal(result.items[0].currentConflicts.length, 1); assert.equal(f.store.drafts().length, 1);
});
test("风险确认只对具体时段生效，原时段恢复可用后重新请求风险确认", async t => {
  const f = fixture(t), s = f.service.open(request("M03", 18));
  const first = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "risk-time.jsonl") });
  const p = first.items[0].proposal!;
  f.service.confirm(s.id, "M03", "douyin", p.id, p.version, ["risk_ack"], "accept");
  writeFileSync(resolve(f.dataDir, "schedules.json"), JSON.stringify([{ channel: "douyin", at: at(19), materialId: "BUSY19" }]));
  const next = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "risk-time-next.jsonl") });
  assert.equal(next.runStatus, "awaiting_input"); assert.equal(next.items[0].proposal?.at, at(18));
  assert.deepEqual(next.items[0].pendingConfirmations, ["risk_ack"]); assert.equal(f.store.drafts().length, 0);
});
test("单项恢复完成不能虚报整批完成，未处理项保留并可重跑继续", async t => {
  const f = fixture(t), s = f.service.open({ requestId: "selected-resume", items: [request("M01", 17).items[0], request("M05", 20).items[0]] });
  const partial = await runSession(f.service, s.id, { mode: "mock", selectedItems: [{ materialId: "M01", channel: "douyin" }], tracePath: resolve(f.dir, "selected.jsonl") });
  assert.equal(partial.items[0].status, "saved"); assert.equal(partial.items[1].status, "checking");
  assert.equal(partial.runStatus, "incomplete"); assert.match(partial.error!, /UNRESOLVED_TASK/); assert.equal(f.store.drafts().length, 1);
  const resumed = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "selected-continue.jsonl") });
  assert.equal(resumed.runStatus, "completed"); assert.equal(f.store.drafts().length, 2);
  assert.equal(resumed.items[0].draft?.id, partial.items[0].draft?.id);
});
