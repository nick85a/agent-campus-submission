import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SchedulerService } from "./service.ts";
import { BusinessError } from "./types.ts";
import { safeError } from "./security/redaction.ts";
import { SchedulerApplication } from "./application/scheduler.ts";

export type ToolBudget = { calls: number; maxCalls: number; deadline: number };

/** Business tool definitions and execution safeguards. Trace is collected by the Pi extension. */
export function createSchedulerTools(service: SchedulerService, context: { sessionId: string; materialId: string; channel: string }, control: { finished: boolean; limitReached: boolean }, budget: ToolBudget) {
  const { sessionId, materialId, channel } = context;
  const app = new SchedulerApplication(service), target = { sessionId, materialId, channel };
  let saveAttempts = 0;
  const reason = Type.String({ minLength: 1, maxLength: 300 });
  const simple = Type.Object({ reason }, { additionalProperties: false });
  const atSchema = Type.Object({ at: Type.String(), reason }, { additionalProperties: false });
  return [
    { name: "get_schedule_state", description: "查询业务状态、缺失字段、待确认项和实际迁移历史；不代替用户确认", parameters: simple, run: () => app.execute("get_schedule_state", target, "agent") },
    { name: "read_material", description: "读取素材；首次读取必须 source=catalog。缺资料时可用 source=supplement 补查可信资料源。source 只允许 catalog 或 supplement", parameters: Type.Object({ source: Type.Union([Type.Literal("catalog"), Type.Literal("supplement")], { description: "资料来源枚举：catalog=素材台账，supplement=可信补充源；只允许这两个值" }), reason }, { additionalProperties: false }), run: (p: any) => app.execute("read_material", { ...target, source: p.source }, "agent") },
    { name: "check_rules", description: "核查资料完整性与规则风险，返回风险依据和有效确认状态", parameters: simple, run: () => app.execute("check_rules", target, "agent") },
    { name: "query_slots", description: "观察实际占用、冲突、已批准时段和可用候选。availableSlots 已按业务偏好排序：原时间，其后由近到远的时段，再向前的时段；无有效已批准建议时优先首项", parameters: simple, run: () => app.execute("query_slots", target, "agent") },
    { name: "request_confirmation", description: "登记具体排期建议和待确认类型，等待用户；此工具不能批准", parameters: atSchema, run: (p: any) => app.execute("request_confirmation", { ...target, at: p.at }, "agent") },
    { name: "save_schedule_draft", description: "事务内复检规则、确认与时段，保存草稿或返回明确失败", parameters: atSchema, run: (p: any) => app.execute("save_schedule_draft", { ...target, at: p.at }, "agent") },
    { name: "finish_run", description: "核验本素材已形成结果并结束；未解决任务不能宣称完成", parameters: simple, run: () => { const result = app.execute("finish_run", target, "agent"); control.finished = true; return result; } },
  ].map(def => defineTool({ name: def.name, label: def.name, description: def.description, parameters: def.parameters, async execute(_callId, params, signal) {
    if (signal?.aborted || control.finished || control.limitReached || Date.now() >= budget.deadline) throw new BusinessError("EXECUTION_STOPPED", "本轮已结束或超时，不能继续操作");
    if (budget.calls >= budget.maxCalls) { control.limitReached = true; throw new BusinessError("EXECUTION_LIMIT", "达到工具调用上限，任务未完成"); }
    budget.calls++;
    let result: Record<string, unknown>;
    try {
      if (def.name === "save_schedule_draft" && ++saveAttempts > 2) throw new BusinessError("SAVE_RETRY_LIMIT", "每项每轮最多尝试保存两次，请结束并报告未完成或失败");
      result = { ok: true, ...def.run(params) };
    } catch (error) { result = { ok: false, code: error instanceof BusinessError ? error.code : "TOOL_FAILURE", message: safeError(error) }; }
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ok: result.ok } };
  } }));
}
