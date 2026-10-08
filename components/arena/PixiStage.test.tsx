// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentState } from "@/lib/client/questReducer";

vi.mock("pixi.js", () => {
  const C = class {
    init() {
      return new Promise(() => {});
    }
    destroy() {}
  };
  return { Application: C, Container: C, Graphics: C, Sprite: C, Text: C };
});
vi.mock("./sprites", () => ({ createAvatarTexture: vi.fn(), SPRITE_SIZE: 16 }));

import PixiStage, { trackSpeaker } from "./PixiStage";

const agent = (id: string, line: string, status: AgentState["status"] = "SPEAKING"): AgentState =>
  ({
    id,
    role: id,
    avatar: "wizard",
    status,
    tokensUsed: 0,
    remainingRatio: 1,
    latestLine: line,
    costUsd: 0,
  }) as AgentState;

afterEach(cleanup);

describe("PixiStage DOM mirror", () => {
  it("uses README labels and aria-live only on the latest speaker", () => {
    const { rerender } = render(
      <PixiStage agents={[agent("lead", "first"), agent("scout", "")]} />,
    );
    rerender(<PixiStage agents={[agent("lead", "first"), agent("scout", "second", "THINKING")]} />);
    const lines = screen.getAllByTestId("stage-a11y-line");
    expect(lines).toHaveLength(2);
    const live = lines.filter((l) => l.getAttribute("aria-live") === "polite");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain("second");
    expect(screen.getByTestId("stage-a11y-list").textContent).toContain("Thinking 🤔");
  });
  it("trackSpeaker picks the agent whose line changed", () => {
    const a = trackSpeaker({ lines: {}, speaker: null }, [agent("a", "x"), agent("b", "")]);
    expect(a.speaker).toBe("a");
    expect(trackSpeaker(a, [agent("a", "x"), agent("b", "y")]).speaker).toBe("b");
  });
});
