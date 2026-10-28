import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../src/store.ts";
import { SchedulerService } from "../src/service.ts";
import type { TestContext } from "node:test";
import type { RequestInput } from "../src/types.ts";
export const at = (hour: number) => `2030-01-01T${String(hour).padStart(2, "0")}:00:00+08:00`;
export const request = (materialId = "M01", hour = 17, requestId = "test"): RequestInput => ({ requestId, items: [{ materialId, channel: "douyin", requirement: { kind: "fixed", at: at(hour) } }] });
export function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "scheduler-test-")), dataDir = resolve(dir, "data"), dbPath = resolve(dir, "test.sqlite");
  cpSync(new URL("../data", import.meta.url), dataDir, { recursive: true });
  const store = new Store(dbPath, dataDir), service = new SchedulerService(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, dataDir, dbPath, store, service };
}
