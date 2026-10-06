// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "./AppShell";
import { CouncilEventSchema, OrchestrationPlanSchema } from "@/lib/shared";
import { MOCK_EVENTS, MOCK_PLAN } from "./mock-data";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const mkEvent = (id: number, agentId: string, action: string, data = {}, tokensUsed = 0) => ({
  id,
  questId: "q1",
  timestamp: "2026-10-06T10:00:00.000Z",
  round: 1,
  agentId,
  action,
  tokensUsed,
  data,
});

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ questId: "q1", plan: MOCK_PLAN }, { status: 201 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("mock data satisfies shared schemas", () => {
    expect(OrchestrationPlanSchema.safeParse(MOCK_PLAN).success).toBe(true);
    for (const e of MOCK_EVENTS) expect(CouncilEventSchema.safeParse(e).success).toBe(true);
  });

  it("switches tabs", () => {
    render(<AppShell />);
    const arena = screen.getByRole("tab", { name: /Visual Arena/ });
    const stream = screen.getByRole("tab", { name: /Discussion Stream/ });
    expect(arena.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("panel-stream")!.className).toContain("hidden");
    fireEvent.click(stream);
    expect(stream.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("panel-arena")!.className).toContain("hidden");
  });

  it("starts empty with Go disabled", () => {
    render(<AppShell />);
    expect(screen.queryAllByTestId("agent-card")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits a quest and renders streamed events", async () => {
    render(<AppShell />);
    fireEvent.change(screen.getByLabelText("Quest"), { target: { value: "Plan a trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(
      "/api/quests",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ query: "Plan a trip" }) }),
    );
    expect(FakeEventSource.instances[0].url).toBe("/api/quests/q1/stream");
    expect(screen.getAllByTestId("agent-card")).toHaveLength(3);

    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit(mkEvent(1, "claude", "THINKING"));
      es.emit(
        mkEvent(
          2,
          "claude",
          "SPEAKING",
          {
            message: "Hi council",
            budget: { used: 750, remaining: 250, remainingRatio: 0.25 },
          },
          750,
        ),
      );
    });
    expect(screen.getAllByText("Hi council").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("progressbar")[0].getAttribute("aria-valuenow")).toBe("25");

    act(() => {
      es.emit(
        mkEvent(3, "lead", "DONE", {
          finalAnswer: "Go to Rome",
          totalTokens: 900,
          totalCostUsd: 0.1,
        }),
      );
    });
    expect(screen.getByTestId("final-answer").textContent).toContain("Go to Rome");
    expect(es.closed).toBe(true);
  });

  it("reconnects with lastEventId when the stream drops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AppShell />);
      fireEvent.change(screen.getByLabelText("Quest"), { target: { value: "q" } });
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      const es = FakeEventSource.instances[0];
      act(() => es.emit(mkEvent(5, "claude", "THINKING")));
      act(() => {
        es.readyState = 2;
        es.onerror?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeEventSource.instances).toHaveLength(2);
      expect(FakeEventSource.instances[1].url).toBe("/api/quests/q1/stream?lastEventId=5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows request errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "nope" }, { status: 500 })),
    );
    render(<AppShell />);
    fireEvent.change(screen.getByLabelText("Quest"), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect((await screen.findByRole("alert")).textContent).toBe("nope");
  });
});
