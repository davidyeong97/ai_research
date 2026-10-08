// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "./AppShell";
import { RecentQuests } from "./RecentQuests";
import { AgentBadge } from "./AgentBadge";
import { initialQuestState, questReducer } from "@/lib/client/questReducer";
import { StatsBar } from "./StatsBar";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const ev = (id: number, action: string, data = {}) => ({
  id,
  questId: "abc",
  timestamp: "2026-10-06T10:00:00.000Z",
  round: 1,
  agentId: "lead",
  action,
  tokensUsed: 0,
  data,
});

const QUESTS = [
  { questId: "a1", query: "Why is the sky blue?", status: "done", source: "mcp", totalTokens: 1, totalCostUsd: 0.1234, createdAt: 1 },
  { questId: "b2", query: "Tabs or spaces?", status: "running", source: "web", totalTokens: 1, totalCostUsd: 0, createdAt: 0 },
];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
});

describe("deep link attach", () => {
  it("attaches to existing stream from seq 0 and shows agent badge", async () => {
    window.history.pushState(null, "", "/?quest=abc");
    const fetchMock = vi.fn(async () => Response.json({ questId: "abc", source: "mcp", status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AppShell />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/quests/abc");
    expect(FakeEventSource.instances[0].url).toBe("/api/quests/abc/stream");
    await waitFor(() => expect(screen.getByTestId("agent-badge")).toBeTruthy());
    act(() => FakeEventSource.instances[0].emit(ev(1, "DONE", { finalAnswer: "42", totalCostUsd: 0.5 })));
    await waitFor(() => expect(screen.getByTestId("stats-phase").textContent).toBe("Verdict"));
  });

  it("shows an error line for unknown quests", async () => {
    window.history.pushState(null, "", "/?quest=nope");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "quest not found" }, { status: 404 })),
    );
    render(<AppShell />);
    await waitFor(() => expect(screen.getByText("Quest not found")).toBeTruthy());
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("reducer attach resets state and records source", () => {
    const s = questReducer(initialQuestState, { type: "attach", questId: "abc", source: "mcp" });
    expect(s).toMatchObject({ questId: "abc", source: "mcp", phase: "running" });
  });
});

describe("badge", () => {
  it("renders only for mcp", () => {
    const { rerender } = render(<AgentBadge source="mcp" />);
    expect(screen.getByTestId("agent-badge").textContent).toContain("Agent");
    rerender(<AgentBadge source="web" />);
    expect(screen.queryByTestId("agent-badge")).toBeNull();
  });

  it("shows in StatsBar for mcp quests", () => {
    const s = questReducer(initialQuestState, { type: "attach", questId: "abc", source: "mcp" });
    render(<StatsBar state={s} />);
    expect(screen.getByTestId("agent-badge")).toBeTruthy();
  });
});

describe("RecentQuests", () => {
  it("lists quests and opens deep link on tap", async () => {
    const fetchMock = vi.fn(async () => Response.json({ quests: QUESTS }));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<RecentQuests open onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getAllByTestId("recent-item")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/quests?limit=20");
    expect(screen.getByText("Why is the sky blue?")).toBeTruthy();
    expect(screen.getByText("$0.123")).toBeTruthy();
    expect(screen.getAllByTestId("agent-badge")).toHaveLength(1);
    fireEvent.click(screen.getAllByTestId("recent-item")[1]);
    expect(onSelect).toHaveBeenCalledWith("b2");
    expect(onClose).toHaveBeenCalled();
  });
});
