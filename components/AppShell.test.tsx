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

  it("shows unread dot on stream tab and auto-switches on verdict", async () => {
    render(<AppShell />);
    fireEvent.change(screen.getByLabelText("Quest"), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    expect(screen.getByTestId("stats-bar")).toBeTruthy();
    act(() => es.emit(mkEvent(1, "claude", "SPEAKING", { message: "one" })));
    act(() => es.emit(mkEvent(2, "claude", "SPEAKING", { message: "two" })));
    expect(screen.getByTestId("unread-dot")).toBeTruthy();
    act(() => es.emit(mkEvent(3, "lead", "DONE", { finalAnswer: "Rome" })));
    expect(
      screen.getByRole("tab", { name: /Discussion Stream/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByTestId("unread-dot")).toBeNull();
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

describe("AppShell HITL controls", () => {
  const calls: { url: string; body: unknown }[] = [];
  async function startQuest() {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/quests")
          return Response.json({ questId: "q1", plan: MOCK_PLAN }, { status: 201 });
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }),
    );
    render(<AppShell />);
    expect(
      (screen.getByRole("button", { name: "Pause Deliberation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Quest"), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    return FakeEventSource.instances[0];
  }

  it("pauses, resumes and injects guidance", async () => {
    const es = await startQuest();
    fireEvent.click(screen.getByRole("button", { name: "Pause Deliberation" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/quests/q1/control", body: { action: "pause" } });
    act(() => es.emit(mkEvent(1, "lead", "PAUSED", { paused: true })));
    expect(screen.getAllByText("Paused ⏸️").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ action: "resume" });
    act(() => es.emit(mkEvent(2, "lead", "PAUSED", { paused: false })));
    expect(screen.queryAllByText("PAUSED")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Director guidance"), { target: { value: "Be brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].body).toEqual({ action: "inject", text: "Be brief" });

    act(() => es.emit(mkEvent(3, "user", "SPEAKING", { message: "Be brief", guidance: true })));
    expect(screen.getByTestId("director-entry").textContent).toContain("Be brief");
    expect(screen.getAllByTestId("agent-card")).toHaveLength(3);
  });

  it("disables controls once the quest is done", async () => {
    const es = await startQuest();
    act(() => es.emit(mkEvent(1, "lead", "DONE", { finalAnswer: "x" })));
    expect((screen.getByLabelText("Director guidance") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Pause Deliberation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the approval modal and posts the decision", async () => {
    const es = await startQuest();
    act(() =>
      es.emit(
        mkEvent(1, "lead", "PAUSED", {
          awaitingApproval: true,
          plan: {
            complexity: 5,
            rounds: 3,
            tools: ["web_search"],
            agents: [{ id: "a", role: "Planner", model: "m/x" }],
          },
          estimatedMaxTokens: 12000,
          estimatedMaxCostUsd: 0.12,
        }),
      ),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Planner");
    expect(dialog.textContent).toContain("m/x");
    expect(dialog.textContent).toContain("web_search");
    expect(screen.getByTestId("est-cost").textContent).toBe("$0.12");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/quests/q1/approve", body: { approved: true } });
    act(() => es.emit(mkEvent(2, "claude", "THINKING")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
