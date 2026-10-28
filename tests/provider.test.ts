import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { runSession } from "../src/agent.ts";
import { fixture, request, at } from "./helpers.ts";

test("真实 Provider 适配器可完成 OpenAI SSE tool calling 协议（上游为测试替身，不是真实模型）", async t => {
  const f = fixture(t), s = f.service.open(request()), bodies: any[] = [];
  const actions = [
    { name: "read_material", args: { source: "catalog", reason: "读取事实" } },
    { name: "check_rules", args: { reason: "核查规则" } },
    { name: "query_slots", args: { reason: "检查时段" } },
    { name: "save_schedule_draft", args: { at: at(17), reason: "按原要求保存" } },
    { name: "finish_run", args: { reason: "已取得保存凭据" } },
  ];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const action = actions[bodies.length - 1];
    if (!action) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `test-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "wire-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_wire_${bodies.length}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }, null));
    res.write(chunk({}, "tool_calls")); res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const names = ["MODEL_BASE_URL", "MODEL_ID", "MODEL_API_KEY", "MODEL_MAX_TOKENS", "MODEL_CONTEXT_WINDOW", "MODEL_DISABLE_THINKING"];
  const old = names.map(k => process.env[k]);
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; process.env.MODEL_ID = "wire-test"; process.env.MODEL_API_KEY = "test-placeholder";
  process.env.MODEL_MAX_TOKENS = "1024"; process.env.MODEL_CONTEXT_WINDOW = "262144"; process.env.MODEL_DISABLE_THINKING = "true";
  try {
    const result = await runSession(f.service, s.id, { mode: "live", tracePath: resolve(f.dir, "wire.jsonl") });
    assert.equal(result.runStatus, "completed", JSON.stringify(result)); assert.equal(f.store.drafts().length, 1); assert.equal(bodies.length, 5);
    assert.ok(bodies[1].messages.some((m: any) => m.role === "tool" && JSON.parse(m.content).material.id === "M01"));
    assert.deepEqual(bodies[0].tools.map((x: any) => x.function.name).sort(), ["get_schedule_state", "read_material", "check_rules", "query_slots", "request_confirmation", "save_schedule_draft", "finish_run"].sort());
    assert.equal(bodies[0].max_tokens ?? bodies[0].max_completion_tokens, 1024);
    assert.deepEqual(bodies[0].thinking, { type: "disabled" });
    assert.equal(bodies[0].temperature, undefined);
  } finally { names.forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
});
test("缺少真实模型配置时明确失败，不自动回退成 Mock 成功", async t => {
  const f = fixture(t), s = f.service.open(request()), old = process.env.MODEL_API_KEY; delete process.env.MODEL_API_KEY;
  try { const result = await runSession(f.service, s.id, { mode: "live", tracePath: resolve(f.dir, "unconfigured.jsonl") }); assert.equal(result.runStatus, "failed"); assert.equal(result.mode, "live"); assert.match(result.error!, /MODEL_BASE_URL/); assert.equal(f.store.drafts().length, 0); }
  finally { if (old !== undefined) process.env.MODEL_API_KEY = old; }
});
test("模型只声称成功却没有调用工具时，输出 incomplete 且没有草稿", async t => {
  const f = fixture(t), s = f.service.open(request());
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "hallucinated", object: "chat.completion.chunk", created: 1, model: "wire-test", choices: [{ index: 0, delta: { role: "assistant", content: "已保存，已发布成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const old = [process.env.MODEL_BASE_URL, process.env.MODEL_ID, process.env.MODEL_API_KEY];
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; process.env.MODEL_ID = "wire-test"; process.env.MODEL_API_KEY = "test-placeholder";
  try { const r = await runSession(f.service, s.id, { mode: "live", tracePath: resolve(f.dir, "hallucinated.jsonl") }); assert.equal(r.runStatus, "incomplete"); assert.equal(r.items[0].saveStatus, "not_saved"); assert.equal(f.store.drafts().length, 0); }
  finally { ["MODEL_BASE_URL", "MODEL_ID", "MODEL_API_KEY"].forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
});
test("模型服务挂起时宿主超时取消，返回 incomplete 且无写入", async t => {
  const f = fixture(t), s = f.service.open(request()), server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const old = [process.env.MODEL_BASE_URL, process.env.MODEL_ID, process.env.MODEL_API_KEY];
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; process.env.MODEL_ID = "wire-test"; process.env.MODEL_API_KEY = "test-placeholder";
  try { const r = await runSession(f.service, s.id, { mode: "live", timeoutMs: 100, tracePath: resolve(f.dir, "timeout.jsonl") }); assert.equal(r.runStatus, "incomplete"); assert.match(r.error!, /TIMEOUT/); assert.equal(f.store.drafts().length, 0); }
  finally { ["MODEL_BASE_URL", "MODEL_ID", "MODEL_API_KEY"].forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
});
