/** Shared error formatting; independent of trace collection and business execution. */
export function redactSensitiveText(value: string): string {
  let result = value;
  if (process.env.MODEL_API_KEY) result = result.split(process.env.MODEL_API_KEY).join("[REDACTED]");
  return result.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}
export function safeError(error: unknown): string { return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000); }
