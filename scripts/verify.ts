import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const dir = resolve("examples/checks"); mkdirSync(dir, { recursive: true });
const startedAt = new Date().toISOString(), checks: { name: string; exitCode: number | null; durationMs: number; log: string }[] = [];
for (const [name, args] of [["typecheck", ["run", "typecheck"]], ["tests", ["test"]], ["examples", ["run", "examples"]], ["chat_examples", ["run", "examples:chat"]], ["business_chat", ["run", "examples:business-chat"]], ["audit", ["audit", "--json"]]] as const) {
  const start = Date.now(), result = spawnSync("npm", [...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  writeFileSync(resolve(dir, `${name}.stdout.txt`), result.stdout ?? ""); writeFileSync(resolve(dir, `${name}.stderr.txt`), result.stderr ?? "");
  checks.push({ name, exitCode: result.status, durationMs: Date.now() - start, log: `examples/checks/${name}.stdout.txt` });
  process.stdout.write(`${name}: ${result.status === 0 ? "PASS" : "FAIL"}\n`);
  if (result.status !== 0) process.exitCode = 1;
}
const testLog = readFileSync(resolve(dir, "tests.stdout.txt"), "utf8"), count = (key: string) => Number(testLog.match(new RegExp(`# ${key} (\\d+)`))?.[1] ?? 0);
const liveStatusPath = resolve("examples/live/validation-status.json");
const liveStatus = existsSync(liveStatusPath) ? JSON.parse(readFileSync(liveStatusPath, "utf8")) : { status: "not_run" };
writeFileSync(resolve(dir, "verification.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform, businessContract: "material-scheduler-v1", stateMachine: "explicit-v1", traceCollector: "pi.on", lockfileSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"), checks, tests: { total: count("tests"), passed: count("pass"), failed: count("fail") }, realModelValidation: { status: liveStatus.status, evidence: "examples/live/validation-status.json", note: "verify 不发起付费模型请求；真实效果以独立 live 运行记录为准" }, implementationStartedAt: "2026-10-28T03:00:10Z" }, null, 2) + "\n");
