import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Store } from "../src/store.ts";
import { resolveChatDate } from "../src/chat/intent.ts";

const startedAt = new Date(), actor = "terminal-recovery-fixture";
mkdirSync(".runtime/evidence", { recursive: true });
const work = mkdtempSync(resolve(".runtime/evidence/terminal-recovery-")), dataDir = resolve(work, "data"), dbPath = resolve(work, "business.sqlite");
const dir = resolve("examples/chat/live-terminal-recovery"); mkdirSync(dir, { recursive: true });
cpSync("data", dataDir, { recursive: true });
const store = new Store(dbPath, dataDir), records: { phase: number; messages: string[]; code: number | null; output: string }[] = [];
let nativeId: string | undefined;
async function chat(phase: number, messages: string[]) {
  const result = await new Promise<{ code: number | null; out: string; err: string }>((accept, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", "--import", "tsx", "src/cli.ts", "chat", "--mode", "live", "--actor", actor, "--db", dbPath, "--data-dir", dataDir, "--trace", resolve(work, `phase-${phase}.trace.jsonl`), "--chat-log", resolve(work, `phase-${phase}.chat.jsonl`)], { env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); accept({ code, out, err }); });
    child.stdin.end(messages.join("\n") + "\n");
  });
  records.push({ phase, messages, code: result.code, output: result.out });
  writeFileSync(resolve(dir, "terminal-records.json"), JSON.stringify({ mode: "live", syntheticData: true, automatedFixture: true, note: "不同真实CLI进程模拟用户输入，不是真人审批", records }, null, 2) + "\n");
  writeFileSync(resolve(dir, `phase-${phase}.stderr.txt`), result.err);
  assert.equal(result.code, 0, result.err);
  const row = store.db.prepare("SELECT context FROM terminal_chat_context WHERE owner=? AND mode='live'").get(actor)!;
  const context = JSON.parse(String(row.context));
  assert.ok(context.piSessionFile);
  const currentId = SessionManager.open(context.piSessionFile).getSessionId();
  if (nativeId) assert.equal(currentId, nativeId); else nativeId = currentId;
  return result.out;
}
try {
  await chat(1, ["安排 M06", "下周一", "17点", "退出"]);
  const rows = store.db.prepare("SELECT payload FROM sessions WHERE owner=?").all(actor); assert.equal(rows.length, 1);
  const session = JSON.parse(String(rows[0].payload)), expectedAt = resolveChatDate("下周一", startedAt) + "T17:00:00+08:00";
  assert.equal(session.items[0].status, "needs_information"); assert.equal(session.items[0].input.requirement.at, expectedAt);
  const second = await chat(2, ["查询待处理清单 m06", "M06", "补充M06标题为双十一优惠", "退出"]);
  assert.match(second, /已恢复上次正在处理的素材/); assert.doesNotMatch(second, /还没有选定素材/);
  assert.equal(store.material("M06").title, "双十一优惠"); assert.equal(store.material("M06").rights, "unknown"); assert.equal(store.drafts().length, 0);
  const beforeGrant = { material: store.material("M06"), drafts: store.drafts() };
  const third = await chat(3, ["已授权", "查看结果", "发布", "退出"]);
  assert.match(third, /草稿已保存/); assert.match(third, /未接入真实发布/);
  assert.equal(store.drafts().length, 1); assert.equal(store.drafts()[0].at, expectedAt);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sessions WHERE owner=?").get(actor)!.n, 1);
  writeFileSync(resolve(dir, "outcome.json"), JSON.stringify({ beforeExplicitGrant: beforeGrant, afterExplicitGrant: { material: store.material("M06"), drafts: store.drafts() } }, null, 2) + "\n");
  writeFileSync(resolve(dir, "validation.json"), JSON.stringify({ at: new Date().toISOString(), mode: "live", model: process.env.MODEL_ID, passed: true, cliProcesses: 3, sameNativePiSession: true, nativeSessionId: nativeId, businessSessions: 1, drafts: 1, expectedAt, syntheticData: true, automatedFixture: true }, null, 2) + "\n");
  process.stdout.write("live terminal recovery: PASS\n");
} catch (error) {
  writeFileSync(resolve(dir, "validation.json"), JSON.stringify({ at: new Date().toISOString(), mode: "live", passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2) + "\n");
  throw error;
} finally {
  const traces = resolve(dir, "admin-traces"); mkdirSync(traces, { recursive: true });
  for (const record of records) {
    const source = resolve(work, `phase-${record.phase}.trace.jsonl`);
    if (existsSync(source)) writeFileSync(resolve(traces, `phase-${record.phase}.jsonl`), readFileSync(source));
  }
  const intake = resolve(".runtime/traces", `intake_${nativeId}.jsonl`);
  if (nativeId && existsSync(intake)) writeFileSync(resolve(traces, "intake.jsonl"), readFileSync(intake));
  store.close();
}
