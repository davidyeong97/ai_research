// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InspectPanel } from "./InspectPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import type { AgentState, InspectSelection, TranscriptEntry } from "@/lib/client/questReducer";

afterEach(cleanup);

const agent: AgentState = {
  id: "a",
  role: "Scout",
  avatar: "wizard",
  status: "SPEAKING",
  tokensUsed: 10,
  remainingRatio: 1,
  latestLine: "hi",
  costUsd: 0.5,
  fallback: { primary: "p/x", modelUsed: "u/y" },
};
const entry: TranscriptEntry = {
  id: 1,
  round: 2,
  agentId: "a",
  action: "SPEAKING",
  kind: "message",
  text: "hello",
  tokensUsed: 42,
  thought: "deep **thought**",
  model: "m/z",
  costUsd: 0.00123,
  latencyMs: 900,
  citations: [
    { url: "https://example.com/a", title: "Ex" },
    { url: "javascript:alert(1)" },
    { url: "https://b.org" },
    { url: "https://c.org" },
  ],
};

function Harness() {
  const [sel, setSel] = useState<InspectSelection | null>(null);
  return (
    <>
      <button onClick={() => setSel({ agentId: "a", entryId: 1 })}>open</button>
      <TranscriptPanel entries={[entry]} onInspect={setSel} />
      {sel && <InspectPanel agent={agent} entry={entry} onClose={() => setSel(null)} />}
    </>
  );
}

describe("InspectPanel", () => {
  it("shows stats, collapsed thought log, and safe citations", () => {
    render(<InspectPanel agent={agent} entry={entry} onClose={() => {}} />);
    expect(screen.getByText("$0.0012")).toBeTruthy();
    expect(screen.getByText("900 ms")).toBeTruthy();
    expect(screen.getByText("m/z")).toBeTruthy();
    expect(screen.getByTestId("inspect-fallback").textContent).toContain("p/x → u/y");
    expect(screen.queryByText("thought")).toBeNull();
    fireEvent.click(screen.getByText(/Thought log/));
    expect(screen.getByText("thought")).toBeTruthy();
    const link = screen.getByText("Ex").closest("a")!;
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(
      screen.getAllByRole("link").every((l) => l.getAttribute("href")?.startsWith("http")),
    ).toBe(true);
  });

  it("closes via button, Escape, and backdrop", () => {
    const onClose = vi.fn();
    render(<InspectPanel agent={agent} entry={entry} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("inspect-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("opens from transcript chips, traps focus, and returns focus", () => {
    render(<Harness />);
    expect(screen.getAllByTestId("citation-chip")).toHaveLength(2);
    const opener = screen.getByText("open");
    opener.focus();
    fireEvent.click(screen.getByTestId("citation-more"));
    expect(screen.getByTestId("inspect-panel")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("inspect-panel").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("inspect-panel")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("full text, thinking and cut-off marker", () => {
  const long = "lorem ipsum ".repeat(1500).trim();
  const thinking = "ponder ".repeat(1500).trim();

  it("TranscriptPanel shows full text, full thinking and (cut off)", () => {
    const e: TranscriptEntry = { ...entry, text: long, thought: thinking, truncated: true };
    render(<TranscriptPanel entries={[e]} />);
    expect(screen.getByTestId("transcript-entry").textContent).toContain(long);
    expect(screen.getByTestId("thinking-text").textContent).toBe(thinking);
    expect(screen.getByTestId("cut-off-marker").textContent).toContain("cut off");
  });

  it("TranscriptPanel omits the marker and thinking when absent", () => {
    render(<TranscriptPanel entries={[{ ...entry, thought: undefined }]} />);
    expect(screen.queryByTestId("cut-off-marker")).toBeNull();
    expect(screen.queryByTestId("thinking-details")).toBeNull();
  });

  it("InspectPanel renders the full text and thought without truncation", () => {
    const e: TranscriptEntry = { ...entry, text: long, thought: thinking, truncated: true };
    render(<InspectPanel agent={agent} entry={e} onClose={() => {}} />);
    expect(screen.getByTestId("inspect-panel").textContent).toContain(long);
    expect(screen.getByTestId("cut-off-marker")).toBeTruthy();
    fireEvent.click(screen.getByText(/Thought log/));
    expect(document.getElementById("inspect-thought")?.textContent).toContain(thinking);
  });
});
