import type { AgentStatus } from "@/lib/client/questReducer";

/** README status labels, shared by the Pixi badges and the DOM StatusBadge. */
export const STATUS_LABELS: Record<AgentStatus, string> = {
  IDLE: "Idle",
  THINKING: "Thinking 🤔",
  SEARCHING: "Searching Web 🌐",
  SPEAKING: "Debating ⚔️",
  FACT_CHECKING: "Fact-Checking 🔍",
  RECALL: "Recalling 🧠",
  CONSENSUS: "Consensus Achieved ✅",
  FALLBACK: "Swapped In 🔄",
  PAUSED: "Paused ⏸️",
  DONE: "Done 🏁",
  ERROR: "Error 💥",
};

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** Badge text; THINKING gets an animated "…" pulse (static when reduced motion). */
export function badgeText(status: AgentStatus, elapsedSec: number, reduced: boolean): string {
  const base = statusLabel(status);
  if (status !== "THINKING") return base;
  if (reduced) return `${base}…`;
  return `${base}${".".repeat(1 + (Math.floor(elapsedSec * 2.5) % 3))}`;
}
