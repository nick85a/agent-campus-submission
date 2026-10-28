import { BusinessError, type BusinessSession, type Draft, type ExistingSchedule, type ItemInput, type ItemState } from "../types.ts";

export function normalizeAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:Z|\+08:00)$/.test(value)) throw new BusinessError("INVALID_TIME", "时间须为带 Z 或 +08:00 的 ISO 整点时间");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new BusinessError("INVALID_TIME", "时间无效");
  const result = new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
  const roundtrip = value.endsWith("Z") ? new Date(ms).toISOString().slice(0, 19) + "Z" : result;
  if (roundtrip !== value) throw new BusinessError("INVALID_TIME", "日期无效");
  return result;
}

export function candidateSlots(input: ItemInput, hours: number[]): string[] {
  const r = input.requirement, first = r.kind === "fixed" ? r.at.slice(0, 10) : r.start.slice(0, 10);
  const last = r.kind === "fixed" ? first : r.end.slice(0, 10), candidates: string[] = [];
  for (let ms = Date.parse(first + "T00:00:00+08:00"); ms <= Date.parse(last + "T00:00:00+08:00"); ms += 86400_000) {
    const date = normalizeAt(new Date(ms).toISOString().slice(0, 19) + "Z").slice(0, 10);
    for (const hour of hours) {
      const at = `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`;
      if (r.kind === "fixed" || (at >= r.start && at <= r.end)) candidates.push(at);
    }
  }
  return candidates.sort((a, b) => {
    if (r.kind !== "fixed") return a.localeCompare(b);
    const da = Date.parse(a) - Date.parse(r.at), db = Date.parse(b) - Date.parse(r.at);
    return (da < 0 ? 1 : 0) - (db < 0 ? 1 : 0) || Math.abs(da) - Math.abs(db);
  });
}

export function slotConflicts(session: BusinessSession, item: ItemState, at: string, schedules: ExistingSchedule[], drafts: Draft[]) {
  const channel = item.input.channel, conflicts: { source: string; materialId: string }[] = [];
  for (const x of schedules) if (x.channel === channel && normalizeAt(x.at) === at) conflicts.push({ source: "existing_schedule", materialId: x.materialId });
  for (const d of drafts) if (d.channel === channel && d.at === at && !(d.sessionId === session.id && d.materialId === item.input.materialId)) conflicts.push({ source: "saved_draft", materialId: d.materialId });
  for (const prior of session.items.slice(0, session.items.indexOf(item))) if (prior.input.channel === channel && prior.suggestedAt === at && prior.status === "needs_confirmation" && prior.proposal?.decision !== "invalidated") conflicts.push({ source: "batch_suggestion", materialId: prior.input.materialId });
  return conflicts;
}
