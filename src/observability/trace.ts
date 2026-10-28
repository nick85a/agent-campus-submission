import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { now } from "../store.ts";

export type TraceSink = (event: string, details: Record<string, unknown>) => void;

export function createTraceSink(path: string, context: { runId: string; sessionId: string; mode: "live" | "mock" }): TraceSink {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  return (event, details) => appendFileSync(target, JSON.stringify({ at: now(), ...context, event, ...details }) + "\n");
}
