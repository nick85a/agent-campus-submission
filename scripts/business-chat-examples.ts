import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import { BusinessChatApi } from "../src/http/chat-service.ts";
import { createBusinessChatServer } from "../src/http/server.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatOptions } from "../src/chat/controller.ts";

const { values } = parseArgs({ options: { mode: { type: "string", default: "mock" }, scenario: { type: "string", default: "conflict" } } });
const mode = values.mode;
if (mode !== "mock" && mode !== "live") throw new Error("mode 须为 mock 或 live");
mkdirSync(".runtime/evidence", { recursive: true }); mkdirSync(".runtime/traces", { recursive: true });
if (!["conflict", "information", "default-channel", "session-context", "supplement-context"].includes(values.scenario!)) throw new Error("scenario 无效");
const information = values.scenario === "information";
const defaultChannel = values.scenario === "default-channel";
const sessionContext = values.scenario === "session-context";
const supplementContext = values.scenario === "supplement-context";
const dir = resolve("examples/business-chat", mode, information ? "information" : defaultChannel ? "default-channel" : sessionContext ? "session-context" : supplementContext ? "supplement-context" : "."), work = mkdtempSync(resolve(".runtime/evidence/business-chat-")), dataDir = resolve(work, "data");
mkdirSync(dir, { recursive: true }); cpSync("data", dataDir, { recursive: true });
const store = new Store(resolve(work, "business.sqlite"), dataDir), service = new SchedulerService(store);
const options: ChatOptions = { mode, tracePath: resolve(work, "scheduler-trace.jsonl"), intakeTraceDir: resolve(work, "intake-traces"), piSessionDir: resolve(work, "pi-sessions") };
let server = createBusinessChatServer(new BusinessChatApi(service, options));
const interactions: { request: unknown; response: any; status: number }[] = [];
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
  async function send(request: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const data = await response.json() as Record<string, any>; interactions.push({ request, response: data, status: response.status });
    writeFileSync(resolve(dir, "http-records.json"), JSON.stringify({ mode, automatedFixture: true, note: "合成业务资料；确认操作由测试客户端模拟，不是真实人工审批", interactions }, null, 2) + "\n");
    assert.equal(response.status, 200); assert.equal(/tracePath|\.runtime|toolCalls|decisions|rulesHash|materialVersion|sessionId|transitions|collector|MODEL_API|tool_start|tool_end|\/Users\//.test(JSON.stringify(data)), false);
    return data;
  }
  if (supplementContext) {
    const first = await send({ message: "安排 M06 2030-01-01 17:00", requestId: "start" });
    assert.equal(first.materials?.[0].reviewStatus, "needs_information");
    const title = await send({ conversationId: first.conversationId, message: mode === "live" ? "标题叫做双十一优惠 授权" : "补充 标题=双十一优惠", requestId: "title" });
    assert.equal(store.material("M06").title, "双十一优惠"); assert.equal(store.material("M06").rights, "unknown");
    assert.equal(title.materials?.[0].reviewStatus, "needs_information"); assert.match(title.message, /请明确授权状态/); assert.equal(store.drafts().length, 0);
    const again = await send({ conversationId: first.conversationId, message: mode === "live" ? "素材为双十一优惠" : "补充 标题=双十一优惠", requestId: "title-again" });
    assert.equal(store.material("M06").title, "双十一优惠"); assert.equal(store.material("M06").rights, "unknown"); assert.equal(store.drafts().length, 0);
    assert.deepEqual(again.materials?.[0].originalRequirement, { kind: "fixed", at: "2030-01-01T17:00:00+08:00" });
    const beforeGrant = { material: store.material("M06"), drafts: store.drafts(), originalRequirement: again.materials[0].originalRequirement };
    const completed = await send({ conversationId: first.conversationId, message: mode === "live" ? "已授权" : "补充 授权=已授权", requestId: "rights" });
    assert.equal(completed.materials?.[0].saveStatus, "saved"); assert.equal(store.material("M06").rights, "granted");
    assert.equal(store.drafts().length, 1); assert.equal(store.drafts()[0].at, "2030-01-01T17:00:00+08:00");
    writeFileSync(resolve(dir, "supplement-proof.json"), JSON.stringify({ mode, beforeExplicitGrant: beforeGrant, afterExplicitGrant: { material: store.material("M06"), drafts: store.drafts() } }, null, 2) + "\n");
  } else if (sessionContext) {
    const first = await send({ message: mode === "live" ? "把 M01 安排在2030年1月1日晚上六点" : "安排 M01 2030-01-01 18:00", requestId: "start" });
    const token = first.confirmation.id;
    const unclear = await send({ conversationId: first.conversationId, message: "统一", requestId: "unclear" });
    assert.equal(unclear.confirmation?.id, token); assert.equal(store.drafts().length, 0);
    const before = JSON.parse(String(store.db.prepare("SELECT context FROM chat_conversations WHERE id=?").get(first.conversationId)!.context));
    const piId = before.piSessionFile ? SessionManager.open(before.piSessionFile).getSessionId() : null;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    server = createBusinessChatServer(new BusinessChatApi(service, options));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
    const saved = await send({ conversationId: first.conversationId, message: "同意", requestId: "agree" });
    assert.equal(saved.materials?.[0].saveStatus, "saved"); assert.equal(store.drafts().length, 1);
    const remembered = await send({ conversationId: first.conversationId, message: mode === "live" ? "刚才安排的是哪项素材，几点？" : "查看结果", requestId: "remember" });
    assert.match(remembered.message, /M01/); assert.match(remembered.message, /19:00/);
    const after = JSON.parse(String(store.db.prepare("SELECT context FROM chat_conversations WHERE id=?").get(first.conversationId)!.context));
    const restoredId = after.piSessionFile ? SessionManager.open(after.piSessionFile).getSessionId() : null;
    assert.equal(restoredId, piId); if (mode === "live") assert.ok(piId);
    writeFileSync(resolve(dir, "pi-session-proof.json"), JSON.stringify({ mode, sameNativeSession: piId === restoredId, nativeSessionId: piId, httpServerRestarted: true, clarificationPreservedCard: unclear.confirmation.id === token, drafts: store.drafts().length }, null, 2) + "\n");
  } else if (defaultChannel) {
    const result = await send({ message: "把 M01 安排在2030年1月1日晚上六点", requestId: "default-channel-regression" });
    assert.equal(result.status, "awaiting_input"); assert.equal(result.materials?.[0].channel, "douyin");
    assert.deepEqual(result.materials[0].originalRequirement, { kind: "fixed", at: "2030-01-01T18:00:00+08:00" });
    assert.equal(result.confirmation?.proposedAt, "2030-01-01T19:00:00+08:00"); assert.equal(store.drafts().length, 0);
  } else if (information) {
    const first = await send({ message: mode === "live" ? "想给 M06 安排一下" : "安排 M06", requestId: "start" });
    await send({ conversationId: first.conversationId, message: "2030年1月1日", requestId: "date" });
    const missing = await send({ conversationId: first.conversationId, message: mode === "live" ? "下午五点" : "17:00", requestId: "time" });
    assert.equal(missing.materials?.[0].reviewStatus, "needs_information"); assert.equal(store.drafts().length, 0);
    const completed = await send({ conversationId: first.conversationId, message: mode === "live" ? "给 M06 补上标题“补充后的教程”，已经获得授权" : "补充 M06，标题=补充后的教程，授权=已授权", requestId: "supplement" });
    assert.equal(completed.materials?.[0].saveStatus, "saved"); assert.equal(store.drafts()[0].at, "2030-01-01T17:00:00+08:00");
  } else {
  const first = await send({ message: mode === "live" ? "把新品介绍放到2030年1月1日晚上六点，发抖音，帮我安排一下" : "安排 M01 2030-01-01 18:00", requestId: "schedule" });
  assert.equal(first.materials?.[0].saveStatus, "not_saved"); assert.equal(first.confirmation?.proposedAt, "2030-01-01T19:00:00+08:00"); assert.equal(store.drafts().length, 0);
  await send({ conversationId: first.conversationId, message: mode === "live" ? "怎么没有按我说的六点排呢？" : "为什么改到19:00？", requestId: "explain" });
  const saved = await send({ conversationId: first.conversationId, action: { confirmationId: first.confirmation.id, decision: "accept", kinds: ["time_change"] }, requestId: "confirm" });
  assert.equal(saved.materials?.[0].saveStatus, "saved");
  const repeated = await send({ conversationId: first.conversationId, message: mode === "live" ? "刚才那条再提交一次，别生成重复的草稿" : "再处理一次相同请求", requestId: "repeat" });
  assert.equal(repeated.materials?.[0].saveStatus, "existing");
  assert.equal(repeated.materials?.[0].draft.id, saved.materials[0].draft.id); assert.equal(store.drafts().length, 1);
  await send({ conversationId: first.conversationId, message: "/trace", requestId: "business-boundary" });
  }
  const sessionId = store.drafts()[0]?.sessionId ?? String(store.db.prepare("SELECT id FROM sessions LIMIT 1").get()!.id);
  writeFileSync(resolve(dir, "outcome.json"), JSON.stringify({ automatedFixture: true, drafts: store.drafts(), latest: service.show(sessionId) }, null, 2) + "\n");
  writeFileSync(resolve(dir, "validation.json"), JSON.stringify({ at: new Date().toISOString(), mode, model: mode === "live" ? process.env.MODEL_ID : "deterministic-mock-v1", passed: true, businessOnlyResponse: true, drafts: store.drafts().length, scope: supplementContext ? "省略当前素材ID补标题，含糊授权不自动通过；再次补标题仍保留17:00，明确已授权后才保存" : sessionContext ? "同一 Pi Session 保留原句、统一澄清和同意；HTTP 重启后恢复历史并查询已存草稿" : defaultChannel ? "原句未指定渠道，业务层使用抖音默认值；保留18:00要求，19:00建议待确认，草稿为零" : mode === "live" ? information ? "真实模型逐轮理解素材、日期、中文时间与授权补充，重新审核后保存；HTTP 响应不含运行记录" : "真实模型理解非命令式表达、解释冲突、夹具确认保存与重跑；HTTP 响应不含运行记录" : "仅验证业务流程和接口边界，不证明真实语言理解", confirmations: information || defaultChannel || supplementContext ? "此场景没有确认操作" : "程序夹具模拟，非真人审批" }, null, 2) + "\n");
  process.stdout.write(`${mode} business chat: PASS\n`);
} finally {
  const traceDir = resolve(dir, "admin-traces"); mkdirSync(traceDir, { recursive: true });
  if (existsSync(resolve(work, "scheduler-trace.jsonl"))) writeFileSync(resolve(traceDir, "scheduler-trace.jsonl"), readFileSync(resolve(work, "scheduler-trace.jsonl")));
  if (existsSync(resolve(work, "intake-traces"))) for (const file of readdirSync(resolve(work, "intake-traces"))) writeFileSync(resolve(traceDir, file), readFileSync(resolve(work, "intake-traces", file)));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
}
