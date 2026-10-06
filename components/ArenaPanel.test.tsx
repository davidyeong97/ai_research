// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentState } from "@/lib/client/questReducer";

vi.mock("next/dynamic", () => ({
  default: () => {
    function Stub({ agents }: { agents: AgentState[] }) {
      return <div data-testid="pixi-stage">{agents.map((a) => a.status).join(",")}</div>;
    }
    return Stub;
  },
}));

import { ArenaPanel } from "./ArenaPanel";

const agent = (id: string): AgentState =>
  ({
    id,
    role: id,
    avatar: "wizard",
    status: "SPEAKING",
    tokensUsed: 0,
    remainingRatio: 1,
    latestLine: "",
    costUsd: 0,
  }) as AgentState;

function setWide(wide: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: wide,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ArenaPanel", () => {
  it("renders the Pixi stage at sm+", () => {
    setWide(true);
    render(<ArenaPanel agents={[agent("a"), agent("b")]} />);
    expect(screen.getByTestId("pixi-stage")).toBeTruthy();
    expect(screen.queryByTestId("compact-rows")).toBeNull();
  });
  it("renders compact rows on narrow viewports", () => {
    setWide(false);
    render(<ArenaPanel agents={[agent("a"), agent("b")]} />);
    expect(screen.queryByTestId("pixi-stage")).toBeNull();
    expect(screen.getAllByTestId("agent-card")).toHaveLength(2);
  });
  it("passes PAUSED status to the stage", () => {
    setWide(true);
    render(<ArenaPanel agents={[agent("a")]} paused />);
    expect(screen.getByTestId("pixi-stage").textContent).toBe("PAUSED");
  });
});
