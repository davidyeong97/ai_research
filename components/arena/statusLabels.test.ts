import { describe, expect, it } from "vitest";
import { badgeText, STATUS_LABELS, statusLabel } from "./statusLabels";

describe("statusLabels", () => {
  it("matches README labels", () => {
    expect(STATUS_LABELS).toEqual({
      THINKING: "Thinking 🤔",
      SEARCHING: "Searching Web 🌐",
      SPEAKING: "Debating ⚔️",
      FACT_CHECKING: "Fact-Checking 🔍",
      CONSENSUS: "Consensus Achieved ✅",
      PAUSED: "Paused ⏸️",
      DONE: "Done 🏁",
      ERROR: "Error 💥",
      FALLBACK: "Swapped In 🔄",
      IDLE: "Idle",
    });
    expect(statusLabel("IDLE")).toBe("Idle");
  });
  it("animates the thinking dots, static when reduced", () => {
    expect(badgeText("THINKING", 0, false)).toBe("Thinking 🤔.");
    expect(badgeText("THINKING", 0.4, false)).toBe("Thinking 🤔..");
    expect(badgeText("THINKING", 0.8, false)).toBe("Thinking 🤔...");
    expect(badgeText("THINKING", 0.4, true)).toBe("Thinking 🤔…");
    expect(badgeText("DONE", 1, false)).toBe("Done 🏁");
  });
});
