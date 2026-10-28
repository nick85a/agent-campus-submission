import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { SchedulerService } from "./service.ts";
import { createRuntime } from "./model.ts";
import { BusinessError } from "./types.ts";
import { hash } from "./store.ts";
import { createTraceSink } from "./observability/trace.ts";
import { safeError } from "./security/redaction.ts";
import { createToolTraceExtension } from "./extensions/trace.ts";
import { createSchedulerTools, type ToolBudget } from "./tools.ts";
import { SchedulerApplication } from "./application/scheduler.ts";
import { isUnfinished } from "./domain/state-machine.ts";

export type RunOptions = { mode: "live" | "mock"; tracePath?: string; maxDecisions?: number; maxTools?: number; timeoutMs?: number; selectedItems?: { materialId: string; channel: string }[] };
export async function runSession(service: SchedulerService, sessionId: string, options: RunOptions) {
  const runId = `r_${randomUUID()}`, tracePath = resolve(options.tracePath ?? `.runtime/traces/${runId}.jsonl`);
  const trace = createTraceSink(tracePath, { runId, sessionId, mode: options.mode });
  const app = new SchedulerApplication(service);
  const control = { decisions: 0, maxDecisions: options.maxDecisions ?? 12, finished: false, limitReached: false };
  const maxTools = options.maxTools ?? 24, timeoutMs = options.timeoutMs ?? 120000;
  for (const n of [control.maxDecisions, maxTools, timeoutMs]) if (!Number.isInteger(n) || n < 1) throw new BusinessError("INVALID_LIMIT", "执行上限和超时须为正整数");
  let observedSteps = 0, error: string | undefined, unfinished = false, currentMaterial: string | undefined;
  const started = Date.now();
  const budget: ToolBudget = { calls: 0, maxCalls: maxTools, deadline: started + timeoutMs };
  const skill = readFileSync(new URL("../skills/content-scheduler/SKILL.md", import.meta.url), "utf8");
  trace("run_start", { sdk: "@earendil-works/pi-coding-agent@1.0.2", businessContract: "material-scheduler-v1", stateMachine: "explicit-v1", toolTraceCollector: "pi.on", model: options.mode === "mock" ? "deterministic-mock-v1" : process.env.MODEL_ID, skillHash: hash(skill), rulesHash: hash(service.store.rules()), limits: { maxDecisions: control.maxDecisions, maxTools, timeoutMs }, mockBoundary: options.mode === "mock" ? "只验证流程，不证明真实模型决策" : null });
  try {
    const { runtime, model } = await createRuntime(options.mode, control, () => trace("model_request", { decision: control.decisions, materialId: currentMaterial }));
    for (const original of app.execute("get_session", { sessionId }).items) {
      if (options.selectedItems && !options.selectedItems.some(i => i.materialId === original.input.materialId && i.channel === original.input.channel)) continue;
      if (Date.now() - started >= timeoutMs) { unfinished = true; error = "TIMEOUT：达到运行超时，任务未完成"; break; }
      if (control.limitReached) { unfinished = true; break; }
      const { materialId, channel } = original.input; currentMaterial = materialId; control.finished = false;
      // Idempotency fast path rechecks current business facts; it is explicitly a host event,
      // never a fabricated model decision. This also lets a budget-limited batch resume.
      if (original.status === "saved") {
        const existing = app.existingDraft({ sessionId, materialId, channel });
        if (existing) {
          try { const result = app.execute("save_schedule_draft", { sessionId, materialId, channel, at: existing.at }); trace("existing_draft_revalidated", { materialId, channel, result }); continue; }
          catch (e) { trace("existing_draft_requires_review", { materialId, channel, message: safeError(e) }); }
        }
      }
      const tools = createSchedulerTools(service, { sessionId, materialId, channel }, control, budget);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } } as any);
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: resolve(".runtime/pi"), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => skill, appendSystemPromptOverride: () => [],
        extensionFactories: [createToolTraceExtension({ trace, materialId, channel, nextStep: () => ++observedSteps })],
      });
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new BusinessError("TRACE_EXTENSION_ERROR", "Pi 观测扩展加载失败");
      const { session } = await createAgentSession({ cwd: process.cwd(), modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, customTools: tools, tools: tools.map(t => t.name), sessionManager: SessionManager.inMemory(), settingsManager });
      session.agent.toolExecution = "sequential";
      const timer = setTimeout(() => { error = "TIMEOUT：模型执行超时，任务未完成"; void session.abort(); }, Math.max(1, timeoutMs - (Date.now() - started)));
      try {
        await session.bindExtensions({ mode: "print", onError: event => { error = `TRACE_EXTENSION_ERROR：${safeError(event.error)}`; void session.abort(); } });
        const current = app.execute("get_session", { sessionId }).items.find(i => i.input.materialId === materialId && i.input.channel === channel)!;
        await session.prompt(JSON.stringify({ sessionId, state: current, businessState: app.execute("get_schedule_state", { sessionId, materialId, channel }), instructions: "处理当前素材，依据工具结果调整动作，最后调用 finish_run。业务状态机约束合法操作，不规定你的工具调用顺序。" }));
        const last = session.messages.findLast(m => m.role === "assistant");
        if (!error && last && "stopReason" in last && last.stopReason === "error" && !control.finished) error = safeError("errorMessage" in last ? last.errorMessage : "模型调用失败");
        if (!control.finished) unfinished = true;
      } finally { clearTimeout(timer); session.dispose(); }
      if (error || unfinished) break;
    }
  } catch (e) { error = safeError(e); }
  const output = app.execute("show_session", { sessionId });
  const statuses = output.items.map(i => i.status);
  const unresolved = unfinished || statuses.some(isUnfinished);
  const runStatus = control.limitReached || error?.startsWith("TIMEOUT") ? "incomplete" : error ? "failed" : unresolved ? "incomplete" : statuses.includes("save_failed") ? "failed" : statuses.some(s => s === "needs_information" || s === "needs_confirmation") ? "awaiting_input" : statuses.includes("blocked") ? "blocked" : statuses.every(s => s === "canceled") ? "canceled" : "completed";
  const localTrace = relative(process.cwd(), tracePath);
  const result = { ...output, runId, mode: options.mode, mockBoundary: options.mode === "mock" ? "离线 Mock 只验证流程，不证明真实模型决策效果" : null, runStatus, error: error ?? (control.limitReached ? "EXECUTION_LIMIT：达到上限，任务未完成" : unresolved ? "UNRESOLVED_TASK：会话仍有未完成项，可用相同输入继续处理" : null), decisions: control.decisions, toolCalls: budget.calls, durationMs: Date.now() - started, tracePath: localTrace.startsWith("..") ? tracePath : localTrace };
  trace("run_end", { result }); return result;
}
