// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActionBar } from "./ActionBar";
import { MAX_ATTACHMENTS } from "@/lib/client/attachments";

const file = (name: string, type: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type });

const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:test/${n++}`;
    created.push(u);
    return u;
  });
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  });
});
afterEach(cleanup);

const pick = (files: File[]) =>
  fireEvent.change(screen.getByTestId("file-input"), { target: { files } });
const go = () => screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;

describe("ActionBar attachments", () => {
  it("adds and removes chips, revoking image object URLs", () => {
    render(<ActionBar onSubmit={vi.fn()} />);
    pick([file("a.png", "image/png"), file("notes.md", "text/markdown", 2048)]);
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(created).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
    expect(revoked).toEqual(created);
  });

  it("revokes object URLs on unmount", () => {
    const { unmount } = render(<ActionBar onSubmit={vi.fn()} />);
    pick([file("a.png", "image/png")]);
    unmount();
    expect(revoked).toEqual(created);
  });

  it("enables Go with an attachment and no text", () => {
    render(<ActionBar onSubmit={vi.fn()} />);
    expect(go().disabled).toBe(true);
    pick([file("a.pdf", "application/pdf")]);
    expect(go().disabled).toBe(false);
  });

  it("shows validation errors for type, size, and count", () => {
    render(<ActionBar onSubmit={vi.fn()} />);
    pick([file("evil.exe", "application/x-msdownload"), file("big.png", "image/png", 11 * 1024 * 1024)]);
    expect(screen.queryAllByTestId("attachment-chip")).toHaveLength(0);
    expect(screen.getByText(/evil\.exe: unsupported/)).toBeTruthy();
    expect(screen.getByText(/big\.png: too large/)).toBeTruthy();
    pick(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`f${i}.txt`, "text/plain")));
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(MAX_ATTACHMENTS);
    expect(screen.getByText(/too many files/)).toBeTruthy();
  });

  it("accepts pasted images", () => {
    render(<ActionBar onSubmit={vi.fn()} />);
    fireEvent.paste(screen.getByLabelText("Quest"), {
      clipboardData: { files: [file("shot.png", "image/png")] },
    });
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  });

  it("submits query with files and clears chips on success", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<ActionBar onSubmit={onSubmit} />);
    const f = file("a.png", "image/png");
    pick([f]);
    fireEvent.click(go());
    expect(onSubmit).toHaveBeenCalledWith("", [f]);
    await waitFor(() => expect(screen.queryAllByTestId("attachment-chip")).toHaveLength(0));
  });

  it("keeps chips when the start fails", async () => {
    const onSubmit = vi.fn(async () => false);
    render(<ActionBar onSubmit={onSubmit} />);
    pick([file("a.png", "image/png")]);
    fireEvent.click(go());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  });

  it("shows Uploading state", () => {
    render(<ActionBar onSubmit={vi.fn()} busy uploading />);
    expect(screen.getByRole("status").textContent).toContain("Uploading");
    expect(go().disabled).toBe(true);
  });
});
