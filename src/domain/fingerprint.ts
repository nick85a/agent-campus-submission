import { createHash } from "node:crypto";

/** Stable identity uses canonical object keys while preserving business batch order. */
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
