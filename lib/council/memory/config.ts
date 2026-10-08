/** Memory env configuration (read lazily so tests can toggle process.env). */

const intEnv = (name: string, def: number, min = 1): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/** Hard ceiling on stored rows regardless of MEMORY_MAX_ROWS. */
export const MEMORY_ROWS_HARD_CAP = 5000;

export const memoryEnabled = (): boolean =>
  (process.env.MEMORY_ENABLED ?? "true").trim().toLowerCase() !== "false";
export const memoryModel = (): string =>
  process.env.MEMORY_MODEL?.trim() || "google/gemini-2.5-flash";
export const memoryEmbedModel = (): string =>
  process.env.MEMORY_EMBED_MODEL?.trim() || "openai/text-embedding-3-small";
export const memoryRecallK = (): number => intEnv("MEMORY_RECALL_K", 5);
export const memoryMaxInjectChars = (): number => intEnv("MEMORY_MAX_INJECT_CHARS", 1200);
export const memoryMaxRows = (): number =>
  Math.min(intEnv("MEMORY_MAX_ROWS", 2000), MEMORY_ROWS_HARD_CAP);
export const memoryConsolidateEnabled = (): boolean =>
  (process.env.MEMORY_CONSOLIDATE ?? "true").trim().toLowerCase() !== "false";
export const memoryDecayDays = (): number => intEnv("MEMORY_DECAY_DAYS", 60);
