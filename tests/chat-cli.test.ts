import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "./helpers.ts";

function childChat(f: ReturnType<typeof fixture>, lines: string[], args: string[] = [], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((accept, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", "--import", "tsx", "src/cli.ts", "chat", "--mode", "mock", "--db", f.dbPath, "--data-dir", f.dataDir, "--trace", resolve(f.dir, "chat-tools.jsonl"), "--chat-log", resolve(f.dir, "chat-messages.jsonl"), ...args], { cwd: process.cwd(), env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data);
    child.on("error", reject); child.on("close", code => accept({ code, out, err }));
    child.stdin.end(lines.join("\n") + "\n");
  });
}
test("终端聊天保留模型等待期间到达的输入，完成真实 CLI 确认与重复提交", async t => {
  const f = fixture(t);
  const r = await childChat(f, ["查看待处理素材", "将 M01 安排在 2030-01-01 18:00，渠道 douyin", "为什么改到19:00？", "同意改期", "再处理一次相同请求", "退出"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /EXISTING01/); assert.match(r.out, /草稿已保存/); assert.match(r.out, /已返回原草稿/);
  assert.equal(f.store.drafts().length, 1);
  const rows = readFileSync(resolve(f.dir, "chat-messages.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
  assert.equal(rows.filter(r => r.role === "user").length, 6); assert.equal(statSync(resolve(f.dir, "chat-messages.jsonl")).mode & 0o777, 0o600);
});
test("关闭聊天后通过 --session 恢复具体建议，显式接受后才保存", async t => {
  const f = fixture(t), first = await childChat(f, ["安排 M01 2030-01-01 18:00", "退出"]);
  assert.equal(first.code, 0, first.err); assert.equal(f.store.drafts().length, 0);
  const session = String(f.store.db.prepare("SELECT id FROM sessions").get()!.id);
  const second = await childChat(f, ["同意这次改到19:00", "退出"], ["--session", session]);
  assert.equal(second.code, 0, second.err); assert.match(second.out, /草稿已保存/); assert.equal(f.store.drafts().length, 1);
});
test("终端重启默认恢复M06原任务，分轮补标题与授权后保存同一会话", async t => {
  const f = fixture(t);
  assert.equal((await childChat(f, ["安排 M06 2030-01-01 17:00", "退出"])).code, 0);
  const second = await childChat(f, ["补充 标题=双十一优惠", "退出"]);
  assert.equal(second.code, 0, second.err); assert.match(second.out, /已恢复上次正在处理的素材/); assert.match(second.out, /请明确授权状态/);
  assert.equal(f.store.drafts().length, 0); assert.equal(f.store.material("M06").rights, "unknown");
  const third = await childChat(f, ["补充 授权=已授权", "退出"]);
  assert.equal(third.code, 0, third.err); assert.match(third.out, /草稿已保存/); assert.equal(f.store.drafts().length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 1);
});
test("终端重启也恢复尚未补齐的排期输入", async t => {
  const f = fixture(t);
  assert.equal((await childChat(f, ["安排 M05", "退出"])).code, 0);
  const result = await childChat(f, ["2030-01-01 17:00", "退出"]);
  assert.equal(result.code, 0, result.err); assert.match(result.out, /已恢复上次尚未补齐/); assert.match(result.out, /草稿已保存/);
  assert.equal(f.store.drafts()[0].materialId, "M05");
});
test("终端与聊天日志脱敏配置密钥，未知输入不会停止后续对话", async t => {
  const f = fixture(t), secret = "test-private-credential-for-redaction";
  const r = await childChat(f, [secret, "查看待处理素材", "退出"], [], { MODEL_API_KEY: secret });
  assert.equal(r.code, 0, r.err); assert.equal(r.out.includes(secret), false); assert.match(r.out, /M06/);
  const log = readFileSync(resolve(f.dir, "chat-messages.jsonl"), "utf8"); assert.equal(log.includes(secret), false); assert.match(log, /\[REDACTED\]/);
});
