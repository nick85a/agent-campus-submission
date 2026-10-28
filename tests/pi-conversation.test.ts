import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PiConversationInterpreter } from "../src/chat/intake.ts";
import { BusinessChatApi } from "../src/http/chat-service.ts";
import { fixture } from "./helpers.ts";
import { ChatController } from "../src/chat/controller.ts";
import { validateMeaning } from "../src/chat/intake.ts";

async function wire(t: Parameters<typeof fixture>[0], actions: (string | Record<string, string>)[]) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let data = ""; req.on("data", b => data += b); req.on("end", () => {
      bodies.push(JSON.parse(data)); const action = actions[bodies.length - 1] ?? "show", meaning = typeof action === "string" ? { action } : action;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "session-test", object: "chat.completion.chunk", created: 1, model: "wire-test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "interpret_" + bodies.length, type: "function", function: { name: "interpret_business_message", arguments: JSON.stringify(meaning) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const names = ["MODEL_BASE_URL", "MODEL_ID", "MODEL_API_KEY"], old = names.map(k => process.env[k]);
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; process.env.MODEL_ID = "wire-test"; process.env.MODEL_API_KEY = "test-placeholder";
  t.after(async () => { names.forEach((name, i) => old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return bodies;
}
test("同一 Pi Session 保留前轮用户和业务回复，处置后从 SessionManager 文件恢复（模型为测试替身）", async t => {
  const f = fixture(t), bodies = await wire(t, ["pending", "confirmation", "show", "show"]);
  const dir = resolve(f.dir, "pi-sessions"), context = { text: "看看待处理素材", materials: [{ id: "M01", title: "新品介绍" }], now: new Date(), timeoutMs: 2000, traceDirectory: resolve(f.dir, "traces") };
  const first = new PiConversationInterpreter(dir); t.after(() => first.dispose());
  await first.interpret(context);
  await first.rememberTurn({ message: context.text }, "M01 建议19:00，等待确认", { materialId: "M01", proposedAt: "19:00" });
  const sessionId = first.sessionId, file = first.sessionFile!;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await assert.rejects(() => first.interpret({ ...context, text: "统一" }), { code: "CHAT_CONFIRMATION_EXPLICIT" });
  await first.rememberTurn({ message: "统一" }, "你是同意M01改到19:00并保存草稿吗？", { materialId: "M01" });
  await first.interpret({ ...context, text: "刚才是哪项素材" });
  assert.equal(first.sessionId, sessionId);
  assert.match(JSON.stringify(bodies[1].messages), /M01 建议19:00/);
  assert.match(JSON.stringify(bodies[2].messages), /统一/);
  assert.match(JSON.stringify(bodies[2].messages), /你是同意M01改到19:00/);
  first.dispose();
  const resumed = new PiConversationInterpreter(dir, file); t.after(() => resumed.dispose());
  assert.equal(resumed.sessionId, sessionId);
  await resumed.interpret({ ...context, text: "接着刚才的安排" });
  assert.match(JSON.stringify(bodies[3].messages), /看看待处理素材/);
  assert.match(JSON.stringify(bodies[3].messages), /统一/);
  assert.match(readFileSync(file, "utf8"), /business_turn/);
});
test("Pi 根据当前缺失字段逐轮补标题和授权，模型引用上下文ID不会导致补资料失败（协议替身）", async t => {
  const f = fixture(t), bodies = await wire(t, [
    { action: "supplement", materialQuote: "M06", titleQuote: "双十一优惠", rightsQuote: "授权" },
    { action: "supplement", materialQuote: "M06", rightsQuote: "已授权" },
  ]);
  const interpreter = new PiConversationInterpreter(resolve(f.dir, "pi")); t.after(() => interpreter.dispose());
  const context = { text: "标题叫做双十一优惠 授权", now: new Date(), materials: [{ id: "M06" }], current: { materialId: "M06", status: "needs_information", originalTime: "2030-01-01T17:00:00+08:00", missingFields: ["title", "rights"] }, timeoutMs: 2000, traceDirectory: resolve(f.dir, "traces") };
  const title = await interpreter.interpret(context);
  assert.equal(title.kind, "supplement"); if (title.kind === "supplement") assert.deepEqual(title.fields, { title: "双十一优惠" });
  await interpreter.rememberTurn({ message: context.text }, "标题已记录，请明确授权状态，目前未保存", { materialId: "M06", missingFields: ["rights"] });
  const rights = await interpreter.interpret({ ...context, text: "已授权", current: { ...context.current, missingFields: ["rights"] } });
  assert.equal(rights.kind, "supplement"); if (rights.kind === "supplement") assert.deepEqual(rights.fields, { rights: "granted" });
  assert.match(JSON.stringify(bodies[1].messages), /标题已记录，请明确授权状态/);
  assert.match(JSON.stringify(bodies[1].messages), /missingFields/);
});
test("HTTP 相同 conversationId 复用 Pi 上下文，重建 API 实例后仍能恢复且不外泄会话文件", async t => {
  const f = fixture(t), bodies = await wire(t, ["pending", "pending", "pending"]);
  const options = { mode: "live" as const, piSessionDir: resolve(f.dir, "api-pi"), intakeTraceDir: resolve(f.dir, "traces") };
  const first = new BusinessChatApi(f.service, options); t.after(() => first.dispose());
  const a = await first.chat({ message: "先看看待处理素材", requestId: "one" });
  await first.chat({ conversationId: a.conversationId, message: "刚才清单还有哪些", requestId: "two" });
  const snapshot = JSON.parse(String(f.store.db.prepare("SELECT context FROM chat_conversations WHERE id=?").get(a.conversationId)!.context));
  assert.ok(snapshot.piSessionFile); assert.equal(JSON.stringify(a).includes("piSessionFile"), false);
  assert.match(JSON.stringify(bodies[1].messages), /先看看待处理素材/);
  assert.match(JSON.stringify(bodies[1].messages), /businessReply/);
  first.dispose();
  const resumed = new BusinessChatApi(f.service, options); t.after(() => resumed.dispose());
  await resumed.chat({ conversationId: a.conversationId, message: "继续刚才的清单", requestId: "three" });
  assert.match(JSON.stringify(bodies[2].messages), /刚才清单还有哪些/);
  const after = JSON.parse(String(f.store.db.prepare("SELECT context FROM chat_conversations WHERE id=?").get(a.conversationId)!.context));
  assert.equal(after.piSessionFile, snapshot.piSessionFile);
});
test("补资料澄清不创建新的排期输入，也不丢失当前素材和时间", async t => {
  const f = fixture(t), initial = new ChatController(f.service, { mode: "mock" });
  await initial.handle("安排 M06 2030-01-01 17:00");
  await initial.handle("补充 标题=双十一优惠");
  const chat = new ChatController(f.service, { mode: "live", interpret: async context => validateMeaning({ action: "supplement", materialQuote: "双十一优惠" }, context) });
  chat.restore(initial.snapshot());
  const clarification = await chat.handle("素材为双十一优惠");
  assert.equal(clarification.errorCode, "CHAT_SUPPLEMENT_INFORMATION_REQUIRED");
  assert.match(clarification.text, /请明确授权状态/); assert.doesNotMatch(clarification.text, /请再说明素材、日期和时间/);
  assert.equal(chat.snapshot().pendingInput, undefined); assert.equal(chat.businessView().materials?.[0].materialId, "M06");
  assert.deepEqual(chat.businessView().materials?.[0].originalRequirement, { kind: "fixed", at: "2030-01-01T17:00:00+08:00" });
  assert.equal(f.store.material("M06").rights, "unknown"); assert.equal(f.store.drafts().length, 0);
});
