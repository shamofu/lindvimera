/** Historical persisted IDs remain recognized even after a backend is removed. */
export type EngineId = "embedded" | "builtin";

export function isEngineId(value: unknown): value is EngineId {
  return value === "embedded" || value === "builtin";
}

export function resolveEngineSelection(
  requested: EngineId | undefined,
  available: readonly EngineId[],
  defaultEngine: EngineId,
): { id: EngineId; migratedFrom?: EngineId } {
  if (!available.includes(defaultEngine)) throw new Error("Default Vim engine is unavailable.");
  if (!requested) return { id: defaultEngine };
  return available.includes(requested)
    ? { id: requested }
    : { id: defaultEngine, migratedFrom: requested };
}
