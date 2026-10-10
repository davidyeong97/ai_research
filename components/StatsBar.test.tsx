// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InspectPanel } from "./InspectPanel";
import { StatsBar, derivePhase } from "./StatsBar";
import { initialQuestState, questReducer, type QuestState } from "@/lib/client/questReducer";
import { MOCK_PLAN } from "./mock-data";

afterEach(cleanup);

const ev = (id: number, round: number, action: string, data = {}, tokensUsed = 0) =>
  ({
    type: "event" as const,
    event: {
      id,
      questId: "q1",
      timestamp: "2026-10-06T10:00:00.000Z",
      round,
      agentId: "claude",
      action,
      tokensUsed,
      data,
    },
  }) as unknown as Parameters<typeof questReducer>[1];

function run(...actions: Parameters<typeof questReducer>[1][]): QuestState {
  return actions.reduce(
    questReducer,
    questReducer(initialQuestState, { type: "start", questId: "q1", plan: MOCK_PLAN }),
  );
}

describe("currentRound reducer field", () => {
  it("tracks max round seen and ignores lower rounds", () => {
    const s = run(ev(1, 1, "THINKING"), ev(2, 3, "THINKING"), ev(3, 2, "THINKING"));
    expect(s.currentRound).toBe(3);
  });
});

describe("StatsBar memory indicator", () => {
  it("is hidden without RECALL and opens the memory view when clicked", () => {
    const { rerender } = render(<StatsBar state={run(ev(1, 1, "THINKING"))} />);
    expect(screen.queryByTestId("stats-memory")).toBeNull();
    const s = run(
      ev(1, 0, "RECALL", { count: 1, ids: ["m1"], kinds: ["fact"], preview: ["sky is blue"] }),
    );
    const open = vi.fn();
    rerender(<StatsBar state={s} onOpenMemory={open} />);
    fireEvent.click(screen.getByTestId("stats-memory"));
    expect(open).toHaveBeenCalled();
    cleanup();
    render(
      <InspectPanel agent={undefined} memories={s.recalled} initialTab="memory" onClose={() => {}} />,
    );
    expect(screen.getByTestId("memory-list").textContent).toContain("fact");
    expect(screen.getByTestId("memory-list").textContent).toContain("sky is blue");
  });
});

describe("StatsBar", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<StatsBar state={initialQuestState} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows round, budget, cost and phase", () => {
    const s = run(ev(1, 2, "SPEAKING", { message: "hi", costUsd: 0.25 }, 3000));
    render(<StatsBar state={s} />);
    expect(screen.getByTestId("stats-round").textContent).toContain(
      `R 2/${MOCK_PLAN.executionPlan.maxRounds}`,
    );
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("10");
    expect(screen.getByTestId("stats-cost").textContent).toBe("$0.250");
    expect(screen.getByTestId("stats-phase").textContent).toBe("Debating");
  });

  it("derives phases", () => {
    expect(derivePhase(run())).toBe("Planning");
    expect(derivePhase(run(ev(1, 1, "THINKING"), ev(2, 1, "PAUSED", { paused: true })))).toBe(
      "Paused",
    );
    expect(derivePhase(run(ev(1, 1, "DONE", { finalAnswer: "x", totalCostUsd: 1 })))).toBe(
      "Verdict",
    );
    expect(derivePhase(run(ev(1, 1, "ERROR", { message: "x" })))).toBe("Error");
  });

  it("uses totalCostUsd once done", () => {
    const s = run(ev(1, 1, "DONE", { finalAnswer: "x", totalCostUsd: 0.5, totalTokens: 100 }));
    render(<StatsBar state={s} />);
    expect(screen.getByTestId("stats-cost").textContent).toBe("$0.500");
  });
});

describe("StatsBar search cost", () => {
  it("shows a search chip when search cost was incurred", () => {
    const s = run(ev(1, 1, "SPEAKING", { message: "x", costUsd: 0.01, searchCostUsd: 0.016 }));
    render(<StatsBar state={s} />);
    expect(screen.getByTestId("stats-search-cost").textContent).toContain("0.016");
  });
});
