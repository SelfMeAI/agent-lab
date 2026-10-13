export const openClawTaskPrefix = "agent:main:agent-lab:";
const legacyTaskPrefix = "agent:main:selfme:";
export const openClawTaskPrefixes = [openClawTaskPrefix, legacyTaskPrefix] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Native task keys are durable history identifiers, not display branding. */
export function labOpenClawTaskId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const prefix of openClawTaskPrefixes) {
    if (value.startsWith(prefix) && uuid.test(value.slice(prefix.length))) return value.slice(prefix.length);
  }
  return null;
}

export function isLabPrivateFile(name: string): boolean {
  return name.startsWith(".agent-lab-") || name.startsWith(".selfme-");
}
