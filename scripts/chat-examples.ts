import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import { runTerminalChat } from "../src/chat/terminal.ts";
import { ChatController, type ChatReply } from "../src/chat/controller.ts";
import type { Draft } from "../src/types.ts";

const { values } = parseArgs({ options: { mode: { type: "string", default: "mock" } } });
const mode = values.mode;
if (mode !== "mock" && mode !== "live") throw new Error("mode 须为 mock 或 live");
const base = resolve("examples/chat", mode); mkdirSync(base, { recursive: true }); mkdirSync(".runtime/evidence", { recursive: true });
const summary: { name: string; passed: boolean; drafts: number; trace: string }[] = [];
const schedule = "将 M01 安排在 2030-01-01 18:00，渠道 douyin";
const cases = mode === "live" ? ["01-conflict-confirm"] : ["01-conflict-confirm", "02-information", "03-save-failure"];
for (const name of cases) {
  const dir = resolve(base, name), work = mkdtempSync(resolve(".runtime/evidence/chat-")), dataDir = resolve(work, "data");
  mkdirSync(dir, { recursive: true }); cpSync(resolve("data"), dataDir, { recursive: true });
  const store = new Store(resolve(work, "business.sqlite"), dataDir), service = new SchedulerService(store, "local-user", name === "03-save-failure" ? "always" : 0);
  const tracePath = resolve(dir, "trace.jsonl"); writeFileSync(tracePath, "");
  writeFileSync(resolve(dir, "initial-data.json"), JSON.stringify({ materials: store.materials(), rules: store.rules(), schedules: store.schedules() }, null, 2) + "\n");
  try {
    const lines = name === "01-conflict-confirm" ? ["查看待处理素材", schedule, "为什么改到19:00？", "如果我说同意呢", "查看结果", "同意这次改到20:00", "同意改期", "再处理一次相同请求", "查看结果", "退出"] : name === "02-information" ? ["安排 M06", "2030-01-01", "17:00", "补充 M06，标题=补充后的教程，授权=已授权", "查看结果", "退出"] : ["安排 M01 2030-01-01 17:00", "重试保存"];
    writeFileSync(resolve(dir, "input.json"), JSON.stringify({ mode, automatedFixture: true, note: "程序提供的合成聊天输入；确认是测试夹具模拟，不是真实人工审批", lines }, null, 2) + "\n");
    let transcript = "";
    if (name !== "03-save-failure") {
      const chatLogPath = resolve(dir, "messages.jsonl"); writeFileSync(chatLogPath, "", { mode: 0o600 });
      await runTerminalChat(service, { mode, tracePath, chatLogPath }, { input: Readable.from(lines.map(l => l + "\n")), output: new Writable({ write(chunk, _encoding, cb) { transcript += chunk.toString(); cb(); } }), terminal: false });
    } else {
      const chat: ChatController = new ChatController(service, { mode, tracePath });
      const failed: ChatReply = await chat.handle(lines[0]); assert.equal(failed.run?.runStatus, "failed"); assert.equal(store.drafts().length, 0);
      writeFileSync(resolve(dir, "failure-outcome.json"), JSON.stringify({ drafts: store.drafts(), output: failed.run }, null, 2) + "\n");
      service.saveFailures = 0;
      writeFileSync(resolve(dir, "recovery-action.json"), JSON.stringify({ automatedFixture: true, action: "恢复故障注入，使存储可用，再从原会话重试" }, null, 2) + "\n");
      const recovered: ChatReply = await chat.handle(lines[1]); assert.equal(recovered.run?.items[0].status, "saved");
      transcript = `你> ${lines[0]}\nAgent> ${failed.text}\n\n[测试夹具恢复存储]\n你> ${lines[1]}\nAgent> ${recovered.text}\n`;
    }
    writeFileSync(resolve(dir, "conversation.txt"), transcript.trimEnd() + "\n");
    const drafts: Draft[] = store.drafts(); assert.equal(drafts.length, 1);
    const draft = drafts[0]; assert.equal(draft.at, name === "01-conflict-confirm" ? "2030-01-01T19:00:00+08:00" : "2030-01-01T17:00:00+08:00");
    const confirmations = service.show(draft.sessionId).confirmations;
    assert.equal(confirmations.length, name === "01-conflict-confirm" ? 1 : 0);
    writeFileSync(resolve(dir, "outcome.json"), JSON.stringify({ mode, automatedFixture: true, passed: true, drafts, latest: service.show(draft.sessionId) }, null, 2) + "\n");
    writeFileSync(resolve(dir, "state-history.json"), JSON.stringify(store.transitions(draft.sessionId), null, 2) + "\n");
    summary.push({ name, passed: true, drafts: drafts.length, trace: `examples/chat/${mode}/${name}/trace.jsonl` });
    process.stdout.write(`${mode}/${name}: PASS\n`);
  } finally { store.close(); }
}
writeFileSync(resolve(base, "summary.json"), JSON.stringify({ at: new Date().toISOString(), mode, model: mode === "live" ? process.env.MODEL_ID : "deterministic-mock-v1", boundary: mode === "mock" ? "只证明流程；离线语言入口使用确定性解析" : "真实 Kimi 理解业务语言并参与排期决策；确认由测试夹具模拟，不是真实人工审批", cases: summary }, null, 2) + "\n");
