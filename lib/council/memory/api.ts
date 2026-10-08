import type { Memory } from "./store";

export const MAX_MEMORY_CHARS = 1000;

/** Shape returned to the client. */
export const publicMemory = (m: Memory) => ({ ...m });
