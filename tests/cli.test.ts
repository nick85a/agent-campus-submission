import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fixture } from "./helpers.ts";

function child(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((accept, reject) => {
    const p = spawn(process.execPath, ["--experimental-sqlite", "--import", "tsx", ...args], { cwd: process.cwd(), env: process.env });
    let out = "", err = ""; p.stdout.on("data", x => out += x); p.stderr.on("data", x => err += x); p.on("error", reject); p.on("close", code => accept({ code, out, err }));
  });
}
test("两个独立进程并发保存只产生一份草稿并返回同一编号", async t => {
  const f = fixture(t);
  const results = await Promise.all([child(["tests/save-worker.ts", f.dbPath, f.dataDir]), child(["tests/save-worker.ts", f.dbPath, f.dataDir])]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(results[0].out).draft.id, JSON.parse(results[1].out).draft.id);
  assert.equal(f.store.drafts().length, 1);
});
test("CLI 跨进程 run→show→confirm→重复 run 的完整确认闭环", async t => {
  const f = fixture(t), base = ["src/cli.ts"], opts = ["--db", f.dbPath, "--data-dir", f.dataDir];
  const first = await child([...base, "run", "--input", "data/inputs/conflict.json", "--mode", "mock", ...opts, "--trace", resolve(f.dir, "cli-first.jsonl")]);
  assert.equal(first.code, 0, first.err); const output = JSON.parse(first.out), p = output.items[0].proposal;
  assert.equal(output.items[0].saveStatus, "not_saved");
  const show = await child([...base, "show", "--session", output.sessionId, ...opts]); assert.equal(JSON.parse(show.out).items[0].proposal.id, p.id);
  const state = await child([...base, "state", "--session", output.sessionId, "--material", "M01", "--channel", "douyin", ...opts]);
  assert.equal(state.code, 0, state.err); assert.equal(JSON.parse(state.out).fsmState, "needs_confirmation"); assert.ok(JSON.parse(state.out).transitions.length > 0);
  const confirmed = await child([...base, "confirm", "--session", output.sessionId, "--material", "M01", "--proposal", p.id, "--version", String(p.version), "--kinds", "time_change", "--decision", "accept", "--mode", "mock", ...opts, "--trace", resolve(f.dir, "cli-confirmed.jsonl")]);
  assert.equal(confirmed.code, 0, confirmed.err); const saved = JSON.parse(confirmed.out); assert.equal(saved.items[0].saveStatus, "saved");
  const repeat = await child([...base, "run", "--input", "data/inputs/conflict.json", "--mode", "mock", ...opts, "--trace", resolve(f.dir, "cli-repeat.jsonl")]);
  assert.equal(repeat.code, 0, repeat.err); assert.equal(JSON.parse(repeat.out).items[0].draft.id, saved.items[0].draft.id); assert.equal(f.store.drafts().length, 1);
});
