import type { Finding, Material, Review, Rules } from "../types.ts";
import { hash } from "./fingerprint.ts";

/** Pure synthetic review rules; no model text, persistence or workflow decisions. */
export function evaluateMaterial(material: Material, rules: Rules): Review {
  const findings: Finding[] = [];
  for (const field of ["title", "text"] as const) if (typeof material[field] !== "string" || !material[field]?.trim()) findings.push({ ruleId: `REQUIRED_${field.toUpperCase()}`, level: "missing", field, evidence: "字段缺失或格式无效" });
  if (material.rights !== "granted" && material.rights !== "denied") findings.push({ ruleId: "RIGHTS_REQUIRED", level: "missing", field: "rights", evidence: "授权未知或格式无效，需要补充资料" });
  if (material.rights === "denied") findings.push({ ruleId: "RIGHTS_DENIED", level: "block", field: "rights", evidence: "授权明确不通过" });
  for (const term of rules.blockedTerms) if (`${material.title ?? ""} ${material.text ?? ""}`.includes(term)) findings.push({ ruleId: `BLOCK_${hash(term).slice(0, 8)}`, level: "block", field: "content", evidence: `命中合成禁止词：${term}` });
  for (const term of rules.warningTerms) if (`${material.title ?? ""} ${material.text ?? ""}`.includes(term)) findings.push({ ruleId: `WARN_${hash(term).slice(0, 8)}`, level: "warning", field: "content", evidence: `需本人复核的合成警告：${term}` });
  const status = findings.some(f => f.level === "block") ? "blocked" : findings.some(f => f.level === "missing") ? "needs_information" : findings.length ? "needs_confirmation" : "passed";
  return { status, findings, materialVersion: material.version, rulesHash: hash(rules) };
}
