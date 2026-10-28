import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import { SchedulerApplication } from "../src/application/scheduler.ts";
import { runSession } from "../src/agent.ts";

// Explicit, small paid-model check; npm run verify never invokes this script.
mkdirSync(".runtime/evidence", { recursive: true }); mkdirSync("examples/live", { recursive: true });
const work = mkdtempSync(resolve(".runtime/evidence/live-smoke-")), cases = [];
for (const [name, inputName, expected] of [["smoke-normal", "normal", "saved"], ["smoke-conflict", "conflict", "needs_confirmation"]] as const) {
  const dir = resolve("examples/live", name), dataDir = resolve(work, name, "data");
  mkdirSync(dir, { recursive: true }); cpSync(resolve("data"), dataDir, { recursive: true });
  const input = JSON.parse(readFileSync(resolve("data/inputs", inputName + ".json"), "utf8"));
  const store = new Store(resolve(work, name, "business.sqlite"), dataDir);
  try {
    const app = new SchedulerApplication(new SchedulerService(store)), session = app.execute("open_session", { input }), tracePath = resolve(dir, "trace.jsonl");
    writeFileSync(resolve(dir, "input.json"), JSON.stringify(input, null, 2) + "\n");
    writeFileSync(resolve(dir, "initial-data.json"), JSON.stringify({ materials: store.materials(), rules: store.rules(), schedules: store.schedules() }, null, 2) + "\n");
    writeFileSync(tracePath, "");
    // runSession creates the same application boundary over the same business service/store.
    const result = await runSession(new SchedulerService(store), session.id, { mode: "live", tracePath, maxDecisions: 10, maxTools: 20, timeoutMs: 60000 });
    const drafts = store.drafts(), item = result.items[0];
    const expectedAt = expected === "saved" ? input.items[0].requirement.at : "2030-01-01T19:00:00+08:00";
    const passed = item.status === expected && result.error === null && result.decisions >= 2 && item.suggestedAt === expectedAt && JSON.stringify(item.originalRequirement) === JSON.stringify(input.items[0].requirement) && (expected === "saved" ? drafts.length === 1 && drafts[0].at === expectedAt && item.pendingConfirmations.length === 0 : drafts.length === 0 && item.pendingConfirmations.includes("time_change") && item.approvedAt === null);
    writeFileSync(resolve(dir, "output.json"), JSON.stringify(result, null, 2) + "\n");
    writeFileSync(resolve(dir, "outcome.json"), JSON.stringify({ drafts, latest: app.execute("show_session", { sessionId: session.id }) }, null, 2) + "\n");
    writeFileSync(resolve(dir, "state-history.json"), JSON.stringify(store.transitions(session.id), null, 2) + "\n");
    const entry = { name, model: process.env.MODEL_ID, expectedStatus: expected, actualStatus: item.status, expectedAt, actualAt: item.suggestedAt, runStatus: result.runStatus, decisions: result.decisions, toolCalls: result.toolCalls, drafts: drafts.length, passed, error: result.error, trace: `examples/live/${name}/trace.jsonl` };
    cases.push(entry); process.stdout.write(JSON.stringify(entry) + "\n");
    if (!passed) { process.exitCode = 1; break; }
  } finally { store.close(); }
}
writeFileSync("examples/live/validation-status.json", JSON.stringify({ at: new Date().toISOString(), status: cases.length === 2 && cases.every(c => c.passed) ? "smoke_verified" : "smoke_failed", configured: Boolean(process.env.MODEL_BASE_URL && process.env.MODEL_ID && process.env.MODEL_API_KEY), model: process.env.MODEL_ID, parameters: { maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 2048), contextWindow: Number(process.env.MODEL_CONTEXT_WINDOW ?? 32000), thinking: process.env.MODEL_DISABLE_THINKING === "true" ? "disabled" : "provider_default" }, scope: "当前业务架构下的真实模型正常与冲突两条路径；未执行完整真实模型评估", cases }, null, 2) + "\n");
