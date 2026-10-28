import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSession } from "../src/agent.ts";
import { fixture, request } from "./helpers.ts";

function events(path: string): Record<string, any>[] { return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)); }

test("Pi 扩展实时采集完整工具生命周期，callId、步骤、参数和结果保持关联", async t => {
  const f = fixture(t), s = f.service.open(request());
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "trace.jsonl") });
  assert.equal(result.runStatus, "completed");
  const all = events(result.tracePath), starts = all.filter(e => e.event === "tool_start"), ends = all.filter(e => e.event === "tool_end");
  assert.equal(all[0].toolTraceCollector, "pi.on"); assert.equal(starts.length, result.toolCalls); assert.equal(ends.length, starts.length);
  assert.equal(all.filter(e => e.event === "model_request").length, result.decisions);
  for (const [index, start] of starts.entries()) {
    const matches = ends.filter(e => e.callId === start.callId);
    assert.equal(matches.length, 1); const end = matches[0];
    assert.equal(start.collector, "pi.on"); assert.equal(start.sdkEvent, "tool_execution_start");
    assert.equal(end.collector, "pi.on"); assert.equal(end.sdkEvent, "tool_execution_end");
    assert.equal(start.step, index + 1); assert.equal(end.step, start.step); assert.equal(end.tool, start.tool);
    assert.equal(start.materialId, "M01"); assert.equal(end.materialId, "M01");
    assert.ok(start.params.reason); assert.equal(end.ok, true); assert.equal(end.sdkIsError, false); assert.ok(end.durationMs >= 0);
  }
  const saved = ends.find(e => e.tool === "save_schedule_draft")!;
  assert.equal(saved.result.draft.id, f.store.drafts()[0].id);
  assert.equal(all.filter(e => e.event === "tool_unfinished").length, 0);
});

test("SDK 成功返回业务失败时 Trace 仍记录 ok=false 与实际错误码", async t => {
  const f = fixture(t), s = f.service.open(request()); f.service.saveFailures = "always";
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "failure.jsonl") });
  const failed = events(result.tracePath).filter(e => e.event === "tool_end" && e.tool === "save_schedule_draft");
  assert.equal(result.runStatus, "failed"); assert.equal(failed.length, 2);
  for (const event of failed) { assert.equal(event.collector, "pi.on"); assert.equal(event.ok, false); assert.equal(event.sdkIsError, false); assert.equal(event.result.code, "SAVE_FAILED"); }
  assert.equal(f.store.drafts().length, 0);
});

test("执行上限抛出的 SDK 工具异常同样由订阅记录，拒绝调用不会写入业务", async t => {
  const f = fixture(t), s = f.service.open(request());
  const result = await runSession(f.service, s.id, { mode: "mock", maxTools: 2, tracePath: resolve(f.dir, "limit.jsonl") });
  const all = events(result.tracePath), failures = all.filter(e => e.event === "tool_end" && e.sdkIsError);
  assert.equal(result.runStatus, "incomplete"); assert.equal(result.toolCalls, 2); assert.equal(f.store.drafts().length, 0);
  assert.equal(failures.length, 1); assert.equal(failures[0].ok, false); assert.match(failures[0].result.message, /上限/);
  assert.equal(all.filter(e => e.event === "tool_start").length, all.filter(e => e.event === "tool_end").length);
});

test("批量素材各自扩展的日志保持正确上下文，步骤在整个 run 内连续", async t => {
  const f = fixture(t), s = f.service.open({ requestId: "trace-batch", items: [request("M01", 18).items[0], request("M05", 18).items[0]] });
  const result = await runSession(f.service, s.id, { mode: "mock", tracePath: resolve(f.dir, "batch.jsonl") });
  assert.equal(result.runStatus, "awaiting_input");
  const all = events(result.tracePath), starts = all.filter(e => e.event === "tool_start");
  assert.deepEqual(starts.map(e => e.step), starts.map((_, i) => i + 1));
  assert.deepEqual([...new Set(starts.map(e => e.materialId))], ["M01", "M05"]);
  for (const start of starts) assert.equal(all.find(e => e.event === "tool_end" && e.callId === start.callId)?.materialId, start.materialId);
});
