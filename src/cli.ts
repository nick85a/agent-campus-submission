import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { SchedulerService } from "./service.ts";
import { runSession } from "./agent.ts";
import { safeError } from "./security/redaction.ts";
import { BusinessError, type Proposal, type RequestInput } from "./types.ts";
import { SchedulerApplication } from "./application/scheduler.ts";
import { runTerminalChat } from "./chat/terminal.ts";

const usage = `素材审核与发布排期 Agent CLI（只保存草稿）
  chat --mode live|mock [--session ID --material M01 --channel douyin]
  pending
  run --input data/inputs/normal.json --mode mock|live
  show --session ID
  state --session ID --material M01 --channel douyin
  supplement --session ID --input data/inputs/supplement.json --mode mock|live
  confirm --session ID --material M01 --channel douyin --proposal ID --version 1 --kinds time_change --decision accept|reject --mode mock|live
  retry --session ID --mode mock|live
公共选项：--db PATH --data-dir PATH --actor NAME --trace PATH
聊天记录：--chat-log PATH
运行选项：--max-decisions 12 --max-tools 24 --timeout-ms 120000
故障演示：--fail-save always|once
live 为默认模式，须配置 MODEL_BASE_URL、MODEL_ID、MODEL_API_KEY。
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { ...Object.fromEntries(["input", "mode", "session", "material", "channel", "proposal", "version", "kinds", "decision", "db", "data-dir", "actor", "trace", "chat-log", "max-decisions", "max-tools", "timeout-ms", "fail-save"].map(k => [k, { type: "string" as const }])), help: { type: "boolean" } } });
  const v = values as Record<string, string | boolean | undefined>;
  const command = positionals[0];
  if (v.help || !command) { process.stdout.write(usage); return; }
  if (positionals.length !== 1 || !["chat", "pending", "run", "show", "state", "supplement", "confirm", "retry"].includes(command)) throw new BusinessError("INVALID_COMMAND", usage);
  const required = (key: string): string => { const value = v[key]; if (typeof value !== "string" || !value) throw new BusinessError("MISSING_ARGUMENT", `缺少 --${key}`); return value; };
  const mode = (v.mode ?? "live") as "live" | "mock";
  if (!["live", "mock"].includes(mode)) throw new BusinessError("INVALID_MODE", "mode 必须为 live 或 mock");
  if (v["fail-save"] && !["always", "once"].includes(String(v["fail-save"]))) throw new BusinessError("INVALID_ARGUMENT", "fail-save 须为 always 或 once");
  const store = new Store(String(v.db ?? ".runtime/scheduler.sqlite"), resolve(String(v["data-dir"] ?? fileURLToPath(new URL("../data", import.meta.url)))));
  try {
    const service = new SchedulerService(store, String(v.actor ?? process.env.SCHEDULER_ACTOR ?? "local-user"), v["fail-save"] === "always" ? "always" : v["fail-save"] === "once" ? 1 : 0);
    const app = new SchedulerApplication(service);
    if (command === "chat") {
      await runTerminalChat(service, { mode, sessionId: v.session as string | undefined, materialId: v.material as string | undefined, channel: v.channel as string | undefined, chatLogPath: v["chat-log"] as string | undefined, tracePath: v.trace as string | undefined, maxDecisions: v["max-decisions"] ? Number(v["max-decisions"]) : undefined, maxTools: v["max-tools"] ? Number(v["max-tools"]) : undefined, timeoutMs: v["timeout-ms"] ? Number(v["timeout-ms"]) : undefined });
      return;
    }
    let result: unknown, id: string | undefined, selectedItems: { materialId: string; channel: string }[] | undefined;
    if (command === "pending") result = { items: app.execute("list_pending", {}) };
    if (command === "show") result = app.execute("show_session", { sessionId: required("session") });
    if (command === "state") result = app.execute("get_schedule_state", { sessionId: required("session"), materialId: required("material"), channel: v.channel as string | undefined });
    if (command === "run") id = app.execute("open_session", { input: JSON.parse(readFileSync(required("input"), "utf8")) as RequestInput }).id;
    if (command === "supplement") {
      id = required("session");
      const patch = JSON.parse(readFileSync(required("input"), "utf8")) as { materialId: string; channel?: string; source: string; fields: Record<string, unknown> };
      const target = app.resolveItem(id, patch.materialId, patch.channel);
      app.execute("supplement_material", { ...target, fields: patch.fields, source: patch.source });
      selectedItems = [{ materialId: patch.materialId, channel: target.channel }];
    }
    if (command === "confirm") {
      id = required("session");
      const target = app.resolveItem(id, required("material"), v.channel as string | undefined);
      const decision = required("decision");
      if (!["accept", "reject"].includes(decision)) throw new BusinessError("INVALID_CONFIRMATION", "decision 须为 accept 或 reject");
      app.execute("confirm_proposal", { ...target, proposalId: required("proposal"), version: Number(required("version")), kinds: required("kinds").split(",") as Proposal["kinds"], decision: decision as "accept" | "reject" });
      selectedItems = [{ materialId: target.materialId, channel: target.channel }];
    }
    if (command === "retry") {
      id = required("session");
      selectedItems = app.execute("retry_session", { sessionId: id }).selectedItems;
    }
    if (id) {
      result = await runSession(service, id, { mode, selectedItems, tracePath: v.trace as string | undefined, maxDecisions: v["max-decisions"] ? Number(v["max-decisions"]) : undefined, maxTools: v["max-tools"] ? Number(v["max-tools"]) : undefined, timeoutMs: v["timeout-ms"] ? Number(v["timeout-ms"]) : undefined });
      if (["failed", "incomplete"].includes((result as { runStatus: string }).runStatus)) process.exitCode = 2;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally { store.close(); }
}
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(error => { process.stderr.write(JSON.stringify({ ok: false, code: error instanceof BusinessError ? error.code : "CLI_ERROR", message: safeError(error) }) + "\n"); process.exitCode = 2; });
