import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { SchedulerService } from "../service.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import { ChatController, type ChatOptions } from "./controller.ts";
import { TerminalCheckpoint } from "./terminal-checkpoint.ts";

export async function runTerminalChat(service: SchedulerService, options: ChatOptions & { sessionId?: string; materialId?: string; channel?: string; chatLogPath?: string }, io: { input: Readable; output: Writable; terminal: boolean } = { input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) }) {
  const controller = new ChatController(service, options), logPath = resolve(options.chatLogPath ?? `.runtime/chats/chat_${randomUUID()}.jsonl`);
  const checkpoint = new TerminalCheckpoint(service, options.mode);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = (role: string, text: string) => appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), mode: options.mode, role, text: redactSensitiveText(text) }) + "\n", { mode: 0o600 });
  const say = (text: string) => { if (text) { io.output.write(`Agent> ${redactSensitiveText(text)}\n\n`); log("assistant", text); } };
  // Async iteration retains piped lines arriving while a model call is running.
  const reader = createInterface({ input: io.input, output: io.output, terminal: io.terminal });
  try {
    say(`你好，我可以帮你审核素材、处理排期冲突和保存草稿。${options.mode === "mock" ? "当前为离线演示，仅验证流程。" : ""}\n默认按抖音、上海时间处理。你想先看看待处理素材，还是安排某项素材？`);
    if (options.sessionId) say(controller.resume(options.sessionId, options.materialId, options.channel));
    else if (checkpoint.context) { controller.restore(checkpoint.context); say(controller.restoredMessage() ?? "已恢复上次对话，可以继续查询或安排素材。"); }
    checkpoint.save(controller.snapshot());
    if (io.terminal) { reader.setPrompt("你> "); reader.prompt(); }
    for await (const line of reader) {
      log("user", line);
      if (!io.terminal) io.output.write(`你> ${redactSensitiveText(line)}\n`);
      const reply = await controller.handle(line); checkpoint.save(controller.snapshot()); say(reply.text);
      if (reply.exit) break;
      if (io.terminal) reader.prompt();
    }
  } finally { reader.close(); controller.dispose(); }
  return logPath;
}
