import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessError, type BusinessSession, type Draft, type ExistingSchedule, type Material, type Rules } from "./types.ts";
export { hash } from "./domain/fingerprint.ts";

export const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  constructor(public path: string, public dataDir = resolve("data")) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(owner,request_id));
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), material_id TEXT NOT NULL, channel TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id,material_id,channel), UNIQUE(channel,at));
      CREATE TABLE IF NOT EXISTS confirmations(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), material_id TEXT NOT NULL, proposal_id TEXT NOT NULL, proposal_version INTEGER NOT NULL, kind TEXT NOT NULL, decision TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, session_id TEXT, action TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);`);
    // Seed only absent materials: supplements survive restart and repeated runs.
    const seed = JSON.parse(readFileSync(resolve(dataDir, "materials.json"), "utf8")) as Material[];
    this.transaction(() => { for (const m of seed) this.db.prepare("INSERT OR IGNORE INTO materials VALUES(?,?)").run(m.id, JSON.stringify(m)); });
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  material(id: string): Material {
    const row = this.db.prepare("SELECT payload FROM materials WHERE id=?").get(id);
    if (!row) throw new BusinessError("MATERIAL_NOT_FOUND", `素材 ${id} 不存在`);
    return JSON.parse(String(row.payload));
  }
  materials(): Material[] { return this.db.prepare("SELECT payload FROM materials ORDER BY id").all().map(r => JSON.parse(String(r.payload))); }
  putMaterial(material: Material) { this.db.prepare("UPDATE materials SET payload=? WHERE id=?").run(JSON.stringify(material), material.id); }
  rules(): Rules {
    const rules = JSON.parse(readFileSync(resolve(this.dataDir, "rules.json"), "utf8")) as Rules;
    if (rules.timezone !== "Asia/Shanghai" || !Array.isArray(rules.hours) || !rules.hours.length || rules.hours.some(h => !Number.isInteger(h) || h < 0 || h > 23)) throw new BusinessError("INVALID_RULES", "规则时区或时段不合法");
    if (!Array.isArray(rules.blockedTerms) || !Array.isArray(rules.warningTerms)) throw new BusinessError("INVALID_RULES", "审核词表必须为数组");
    return rules;
  }
  schedules(): ExistingSchedule[] {
    return JSON.parse(readFileSync(resolve(this.dataDir, "schedules.json"), "utf8"));
  }
  supplementSource(id: string): Record<string, unknown> | undefined {
    return (JSON.parse(readFileSync(resolve(this.dataDir, "supplements.json"), "utf8")) as Record<string, Record<string, unknown>>)[id];
  }
  session(id: string, owner?: string): BusinessSession {
    const row = this.db.prepare("SELECT payload FROM sessions WHERE id=?").get(id);
    if (!row) throw new BusinessError("SESSION_NOT_FOUND", "业务会话不存在");
    const s = JSON.parse(String(row.payload)) as BusinessSession;
    if (owner && s.owner !== owner) throw new BusinessError("FORBIDDEN", "只能操作本人会话");
    return s;
  }
  putSession(s: BusinessSession) {
    const old = s.version; s.version++; s.updatedAt = now();
    const r = this.db.prepare("UPDATE sessions SET payload=?,version=? WHERE id=? AND version=?").run(JSON.stringify(s), s.version, s.id, old);
    if (r.changes !== 1) throw new BusinessError("STALE_SESSION", "会话版本已变化，请重新读取");
  }
  insertSession(s: BusinessSession) {
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(s.id, s.owner, s.requestId, s.fingerprint, s.version, JSON.stringify(s));
  }
  drafts(): Draft[] { return this.db.prepare("SELECT payload FROM drafts ORDER BY at,id").all().map(r => JSON.parse(String(r.payload))); }
  draftFor(sessionId: string, materialId: string, channel: string): Draft | undefined {
    const row = this.db.prepare("SELECT payload FROM drafts WHERE session_id=? AND material_id=? AND channel=?").get(sessionId, materialId, channel);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  audit(sessionId: string | null, action: string, payload: unknown) {
    this.db.prepare("INSERT INTO audit VALUES(?,?,?,?,?)").run(randomUUID(), sessionId, action, now(), JSON.stringify(payload));
  }
  transitions(sessionId: string, materialId?: string, channel?: string) {
    return this.db.prepare("SELECT at,payload FROM audit WHERE session_id=? AND action='state_transition' ORDER BY rowid").all(sessionId)
      .map(row => ({ at: String(row.at), ...JSON.parse(String(row.payload)) as { materialId: string; channel: string; from: string; to: string; event: string; reason: string | null } }))
      .filter(row => (!materialId || row.materialId === materialId) && (!channel || row.channel === channel));
  }
}
