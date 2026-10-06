// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { FinalAnswer } from "./FinalAnswer";
import { TranscriptPanel } from "./TranscriptPanel";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headings, lists and code", () => {
    const { container } = render(<Markdown>{"# Title\n\n- a\n- b\n\n```\ncode\n```"}</Markdown>);
    expect(container.querySelector("h3")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain("code");
  });
  it("does not render raw HTML", () => {
    const { container } = render(<Markdown>{"hi <script>alert(1)</script><b>x</b>"}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
  it("strips javascript: links and hardens safe ones", () => {
    const { container } = render(
      <Markdown>{"[bad](javascript:alert(1)) [ok](https://example.com)"}</Markdown>,
    );
    const links = container.querySelectorAll("a");
    expect(links[0].getAttribute("href")).toBeNull();
    expect(links[1].getAttribute("href")).toBe("https://example.com");
    expect(links[1].getAttribute("target")).toBe("_blank");
    expect(links[1].getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });
});

describe("FinalAnswer", () => {
  it("shows verdict and copies", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<FinalAnswer text="**done**" />);
    expect(screen.getByText(/Council's Verdict/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("**done**");
  });
  it("is rendered by TranscriptPanel when finalAnswer given", () => {
    render(<TranscriptPanel entries={[]} finalAnswer="answer" />);
    expect(screen.getByTestId("final-answer")).toBeTruthy();
  });
});
