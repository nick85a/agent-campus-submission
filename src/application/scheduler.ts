import { SchedulerService } from "../service.ts";
import { BusinessError, type Proposal, type RequestInput } from "../types.ts";

export type ItemTarget = { sessionId: string; materialId: string; channel: string };
type Payloads = {
  open_session: { input: RequestInput };
  get_session: { sessionId: string };
  show_session: { sessionId: string };
  list_pending: Record<string, never>;
  find_material_tasks: { materialId: string; channel?: string };
  get_schedule_state: { sessionId: string; materialId: string; channel?: string };
  read_material: ItemTarget & { source: "catalog" | "supplement" };
  check_rules: ItemTarget;
  query_slots: ItemTarget;
  describe_requested_conflicts: ItemTarget;
  request_confirmation: ItemTarget & { at: string };
  save_schedule_draft: ItemTarget & { at: string };
  finish_run: ItemTarget;
  supplement_material: ItemTarget & { fields: Record<string, unknown>; source: string };
  confirm_proposal: ItemTarget & { proposalId: string; version: number; kinds: Proposal["kinds"]; decision: "accept" | "reject" };
  retry_session: { sessionId: string };
};
type Results = {
  open_session: ReturnType<SchedulerService["open"]>;
  get_session: ReturnType<SchedulerService["session"]>;
  show_session: ReturnType<SchedulerService["show"]>;
  list_pending: ReturnType<SchedulerService["pending"]>;
  find_material_tasks: ReturnType<SchedulerService["materialTasks"]>;
  get_schedule_state: ReturnType<SchedulerService["getState"]>;
  read_material: ReturnType<SchedulerService["readMaterial"]>;
  check_rules: ReturnType<SchedulerService["checkRules"]>;
  query_slots: ReturnType<SchedulerService["querySlots"]>;
  describe_requested_conflicts: ReturnType<SchedulerService["requestedConflicts"]>;
  request_confirmation: ReturnType<SchedulerService["requestConfirmation"]>;
  save_schedule_draft: ReturnType<SchedulerService["saveDraft"]>;
  finish_run: ReturnType<SchedulerService["finish"]>;
  supplement_material: ReturnType<SchedulerService["supplement"]>;
  confirm_proposal: ReturnType<SchedulerService["confirm"]>;
  retry_session: { sessionId: string; selectedItems: { materialId: string; channel: string }[] };
};
export type SchedulerAction = keyof Payloads;
type Handlers = { [A in SchedulerAction]: (payload: Payloads[A]) => Results[A] };
const hostOnly = new Set<SchedulerAction>(["open_session", "supplement_material", "confirm_proposal", "retry_session"]);

/** One business command contract shared by CLI, Pi tools and evaluation harnesses. */
export class SchedulerApplication {
  private readonly handlers: Handlers;
  constructor(private readonly service: SchedulerService) {
    this.handlers = {
      open_session: p => service.open(p.input),
      get_session: p => service.session(p.sessionId),
      show_session: p => service.show(p.sessionId),
      list_pending: () => service.pending(),
      find_material_tasks: p => service.materialTasks(p.materialId, p.channel),
      get_schedule_state: p => service.getState(p.sessionId, p.materialId, p.channel),
      read_material: p => service.readMaterial(p.sessionId, p.materialId, p.channel, p.source),
      check_rules: p => service.checkRules(p.sessionId, p.materialId, p.channel),
      query_slots: p => service.querySlots(p.sessionId, p.materialId, p.channel),
      describe_requested_conflicts: p => service.requestedConflicts(p.sessionId, p.materialId, p.channel),
      request_confirmation: p => service.requestConfirmation(p.sessionId, p.materialId, p.channel, p.at),
      save_schedule_draft: p => service.saveDraft(p.sessionId, p.materialId, p.channel, p.at),
      finish_run: p => service.finish(p.sessionId, p.materialId, p.channel),
      supplement_material: p => service.supplement(p.sessionId, p.materialId, p.channel, p.fields, p.source),
      confirm_proposal: p => service.confirm(p.sessionId, p.materialId, p.channel, p.proposalId, p.version, p.kinds, p.decision),
      retry_session: p => {
        const selectedItems = service.session(p.sessionId).items.filter(i => i.status === "save_failed").map(i => ({ materialId: i.input.materialId, channel: i.input.channel }));
        if (!selectedItems.length) throw new BusinessError("INVALID_STATE", "retry 仅适用于含保存失败项的会话");
        return { sessionId: p.sessionId, selectedItems };
      },
    };
  }
  execute<A extends SchedulerAction>(action: A, payload: Payloads[A], source: "host" | "agent" = "host"): Results[A] {
    if (!Object.hasOwn(this.handlers, action)) throw new BusinessError("UNKNOWN_ACTION", "未注册的业务动作；本系统只保存排期草稿");
    if (source !== "host" && source !== "agent") throw new BusinessError("INVALID_CALLER", "业务调用来源无效");
    const handler = this.handlers[action];
    if (typeof handler !== "function") throw new BusinessError("UNKNOWN_ACTION", "未注册的业务动作；本系统只保存排期草稿");
    if (source === "agent" && hostOnly.has(action)) throw new BusinessError("HOST_ACTION_REQUIRED", "该操作必须来自用户 CLI，模型不能代替用户确认或修改资料");
    return handler(payload);
  }
  resolveItem(sessionId: string, materialId: string, channel?: string): ItemTarget {
    const state = this.execute("get_schedule_state", { sessionId, materialId, channel });
    return { sessionId, materialId, channel: state.channel };
  }
  existingDraft(target: ItemTarget) {
    this.resolveItem(target.sessionId, target.materialId, target.channel);
    return this.service.store.draftFor(target.sessionId, target.materialId, target.channel);
  }
}
