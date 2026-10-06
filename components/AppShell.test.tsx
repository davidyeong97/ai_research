// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";
import { MOCK_AGENTS } from "./mock-data";
import { CouncilEventSchema, OrchestrationPlanSchema } from "@/lib/shared";
import { MOCK_EVENTS, MOCK_PLAN } from "./mock-data";

afterEach(cleanup);

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

  it("renders agent cards and disabled action buttons", () => {
    render(<AppShell />);
    expect(screen.getAllByTestId("agent-card")).toHaveLength(MOCK_AGENTS.length);
    for (const n of ["Pause", "Inject", "Approve"]) {
      expect((screen.getByRole("button", { name: n }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
