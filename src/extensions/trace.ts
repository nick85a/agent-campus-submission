import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TraceSink } from "../observability/trace.ts";
import { safeError } from "../security/redaction.ts";

type PendingTool = { started: number; step: number };

/** Adapt SDK results to the existing business Trace schema without changing tool results. */
function observedResult(value: unknown, isError: boolean): Record<string, unknown> {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (envelope.structuredContent && typeof envelope.structuredContent === "object") return envelope.structuredContent as Record<string, unknown>;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* SDK validation, cancellation and thrown errors may return plain text. */ }
  return { ok: !isError, message: safeError(text || "工具没有结构化返回") };
}

/** Observation only: never calls business services or changes permission/budget decisions. */
export function createToolTraceExtension(options: {
  trace: TraceSink;
  materialId: string;
  channel: string;
  nextStep: () => number;
}): ExtensionFactory {
  return pi => {
    const pending = new Map<string, PendingTool>();
    const context = { materialId: options.materialId, channel: options.channel, collector: "pi.on" };

    pi.on("tool_execution_start", event => {
      const step = options.nextStep();
      pending.set(event.toolCallId, { started: Date.now(), step });
      options.trace("tool_start", { ...context, callId: event.toolCallId, step, tool: event.toolName, params: event.args, sdkEvent: event.type });
    });

    pi.on("tool_execution_end", event => {
      const start = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      const result = observedResult(event.result, event.isError);
      // A business failure is often a valid SDK result whose body has ok=false.
      const ok = !event.isError && result.ok !== false;
      options.trace("tool_end", { ...context, callId: event.toolCallId, step: start?.step, tool: event.toolName, ok, sdkIsError: event.isError, result, durationMs: start ? Math.max(0, Date.now() - start.started) : null, sdkEvent: event.type });
    });

    pi.on("agent_end", () => {
      for (const [callId, start] of pending) options.trace("tool_unfinished", { ...context, callId, step: start.step, durationMs: Math.max(0, Date.now() - start.started), sdkEvent: "agent_end" });
      pending.clear();
    });
  };
}
