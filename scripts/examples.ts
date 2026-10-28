import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store, hash, now } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import { runSession } from "../src/agent.ts";
import type { RequestInput } from "../src/types.ts";
import { SchedulerApplication } from "../src/application/scheduler.ts";

const { values } = parseArgs({ options: { mode: { type: "string", default: "mock" } } });
const mode = values.mode as "mock" | "live";
if (!["mock", "live"].includes(mode)) throw new Error("mode 须为 mock 或 live");
const base = resolve("examples", mode); mkdirSync(base, { recursive: true }); mkdirSync(resolve(".runtime/evidence"), { recursive: true });
const configured = Boolean(process.env.MODEL_BASE_URL && process.env.MODEL_ID && process.env.MODEL_API_KEY);
if (mode === "live" && !configured) {
  writeFileSync(resolve(base, "validation-status.json"), JSON.stringify({ at: now(), status: "not_run", reason: "缺少真实模型配置，未验证真实模型决策", configured: false }, null, 2) + "\n");
  process.stderr.write("缺少真实模型配置，未运行真实模型评估。\n"); process.exitCode = 2;
} else {
  const summary: unknown[] = [];
  const input = (name: string): RequestInput => JSON.parse(readFileSync(resolve("data/inputs", name + ".json"), "utf8"));
  const time = (h: number) => `2030-01-01T${h}:00:00+08:00`;
  async function scenario(name: string, request: RequestInput, expectedStatus: string, fn?: (service: SchedulerService, id: string, dir: string, dataDir: string) => Promise<void>, failure: number | "always" = 0, maxDecisions?: number) {
    const dir = resolve(base, name); mkdirSync(dir, { recursive: true });
    const work = mkdtempSync(resolve(".runtime/evidence", name + "-")), dataDir = resolve(work, "data"); cpSync(resolve("data"), dataDir, { recursive: true });
    const store = new Store(resolve(work, "business.sqlite"), dataDir), service = new SchedulerService(store, "local-user", failure);
    try {
      const app = new SchedulerApplication(service), s = app.execute("open_session", { input: request }), tracePath = resolve(dir, "trace.jsonl");
      writeFileSync(resolve(dir, "input.json"), JSON.stringify(request, null, 2) + "\n");
      writeFileSync(resolve(dir, "initial-data.json"), JSON.stringify({ materials: store.materials(), rules: store.rules(), schedules: store.schedules() }, null, 2) + "\n");
      writeFileSync(tracePath, "");
      const result = await runSession(service, s.id, { mode, tracePath, maxDecisions });
      writeFileSync(resolve(dir, "output.json"), JSON.stringify(result, null, 2) + "\n");
      const passed = expectedStatus === "incomplete" ? result.runStatus === "incomplete" : result.items[0].status === expectedStatus;
      if (fn) await fn(service, s.id, dir, dataDir);
      writeFileSync(resolve(dir, "outcome.json"), JSON.stringify({ at: now(), mode, automatedFixture: true, expectedFirstStatus: expectedStatus, actualFirstStatus: result.items[0].status, passed, drafts: store.drafts(), latest: app.execute("show_session", { sessionId: s.id }) }, null, 2) + "\n");
      writeFileSync(resolve(dir, "state-history.json"), JSON.stringify(store.transitions(s.id), null, 2) + "\n");
      summary.push({ name, mode, expectedStatus, actualStatus: result.items[0].status, passed, output: `examples/${mode}/${name}/output.json`, trace: `examples/${mode}/${name}/trace.jsonl`, outcome: `examples/${mode}/${name}/outcome.json` });
      if (!passed) process.exitCode = 1;
    } finally { store.close(); }
  }
  async function recordResume(service: SchedulerService, id: string, dir: string, name: string) {
    const tracePath = resolve(dir, `${name}.trace.jsonl`); writeFileSync(tracePath, "");
    const result = await runSession(service, id, { mode, tracePath });
    writeFileSync(resolve(dir, `${name}.output.json`), JSON.stringify(result, null, 2) + "\n");
    return result;
  }
  await scenario("01-normal", input("normal"), "saved");
  await scenario("02-missing", input("missing"), "needs_information", async (svc, id, dir) => {
    const patch = JSON.parse(readFileSync(resolve("data/inputs/supplement.json"), "utf8"));
    new SchedulerApplication(svc).execute("supplement_material", { sessionId: id, materialId: patch.materialId, channel: "douyin", fields: patch.fields, source: patch.source });
    writeFileSync(resolve(dir, "supplement-action.json"), JSON.stringify({ automatedFixture: true, ...patch }, null, 2) + "\n");
    const r = await recordResume(svc, id, dir, "after-supplement"); if (r.items[0].status !== "saved") process.exitCode = 1;
  });
  await scenario("03-risk-warning", input("risk"), "needs_confirmation");
  await scenario("04-risk-blocked", input("blocked"), "blocked");
  await scenario("05-conflict-confirm", input("conflict"), "needs_confirmation", async (svc, id, dir) => {
    const app = new SchedulerApplication(svc), p = app.execute("get_session", { sessionId: id }).items[0].proposal;
    if (!p) return;
    const action = { automatedFixture: true, note: "脚本模拟用户操作，不是真实人工审批记录", actor: "local-user", materialId: "M01", proposalId: p.id, version: p.version, kinds: p.kinds, decision: "accept" };
    writeFileSync(resolve(dir, "confirmation-action.json"), JSON.stringify(action, null, 2) + "\n");
    app.execute("confirm_proposal", { sessionId: id, materialId: "M01", channel: "douyin", proposalId: p.id, version: p.version, kinds: p.kinds, decision: "accept" });
    const r = await recordResume(svc, id, dir, "after-confirm"); if (r.items[0].status !== "saved") process.exitCode = 1;
  });
  await scenario("06-save-failure", input("normal"), "save_failed", async (svc, id, dir) => {
    writeFileSync(resolve(dir, "failure-outcome.json"), JSON.stringify({ drafts: svc.store.drafts(), item: new SchedulerApplication(svc).execute("show_session", { sessionId: id }).items[0], fault: "INSERT 后抛错，事务回滚" }, null, 2) + "\n");
    svc.saveFailures = 0; const r = await recordResume(svc, id, dir, "after-retry"); if (r.items[0].status !== "saved") process.exitCode = 1;
  }, "always");
  await scenario("07-duplicate", input("normal"), "saved", async (svc, id, dir) => {
    const firstId = svc.store.drafts()[0]?.id; const r = await recordResume(svc, id, dir, "repeat");
    if (r.items[0].draft?.id !== firstId || svc.store.drafts().length !== 1) process.exitCode = 1;
  });
  await scenario("08-supplement-source", input("auto-supplement"), "saved");
  await scenario("09-changed-occupancy", input("conflict"), "needs_confirmation", async (svc, id, dir, dataDir) => {
    const replacement = [{ channel: "douyin", at: time(19), materialId: "BUSY19" }];
    writeFileSync(resolve(dataDir, "schedules.json"), JSON.stringify(replacement));
    writeFileSync(resolve(dir, "replacement-schedules.json"), JSON.stringify(replacement, null, 2) + "\n");
    const r = await recordResume(svc, id, dir, "after-change"); if (r.items[0].draft?.at !== time(18)) process.exitCode = 1;
  });
  await scenario("10-execution-limit", input("normal"), "incomplete", undefined, 0, 2);
  await scenario("11-batch", { requestId: "demo-batch", items: [input("conflict").items[0], { ...input("conflict").items[0], materialId: "M05" }] }, "needs_confirmation");
  writeFileSync(resolve(base, "summary.json"), JSON.stringify({ generatedAt: now(), mode, model: mode === "mock" ? "deterministic-mock-v1" : process.env.MODEL_ID, boundary: mode === "mock" ? "仅验证流程，不证明真实模型决策效果" : "真实服务运行，检查具体输出与轨迹后评价", dataHash: hash(JSON.parse(readFileSync(resolve("data/materials.json"), "utf8"))), scenarios: summary }, null, 2) + "\n");
  process.stdout.write(`已生成 ${summary.length} 组 ${mode} 输入、实际输出、Trace 与存储结果：examples/${mode}\n`);
}
