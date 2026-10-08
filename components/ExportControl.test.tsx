// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ExportControl } from "./ExportControl";

afterEach(cleanup);

describe("ExportControl", () => {
  it("renders nothing without a quest", () => {
    render(<ExportControl questId={null} />);
    expect(screen.queryByTestId("export-control")).toBeNull();
  });

  it("links to md and json exports with 44px touch targets", () => {
    render(<ExportControl questId="q1" />);
    const md = screen.getByTestId("export-md");
    expect(md.getAttribute("href")).toBe("/api/quests/q1/export?format=md");
    expect(md.className).toContain("min-h-11");
    expect(screen.getByTestId("export-json").getAttribute("href")).toBe(
      "/api/quests/q1/export?format=json",
    );
  });
});
