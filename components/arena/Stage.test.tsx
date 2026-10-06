// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentState } from "@/lib/client/questReducer";
import { Stage, orderAgents } from "./Stage";

const mk = (id: string, avatar: string, status: AgentState["status"] = "IDLE"): AgentState =>
  ({
    id,
    role: id,
    avatar,
    status,
    tokensUsed: 0,
    remainingRatio: 1,
    latestLine: "",
  }) as AgentState;

describe("Stage", () => {
  it("renders one sprite per agent", () => {
    render(
      <Stage agents={[mk("a", "wizard"), mk("b", "rogue", "SPEAKING"), mk("lead", "knight")]} />,
    );
    expect(screen.getAllByTestId("pixel-sprite")).toHaveLength(3);
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });
  it("seats lead first and flashes on error", () => {
    expect(orderAgents([mk("a", "wizard"), mk("lead", "knight")])[0].id).toBe("lead");
    render(<Stage agents={[mk("a", "wizard", "ERROR")]} />);
    expect(screen.getByTestId("error-flash")).toBeTruthy();
  });
});
