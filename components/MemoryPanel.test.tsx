// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryPanel, type MemoryItem } from "./MemoryPanel";

const mem = (id: string, content: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  kind: "fact",
  content,
  sourceQuestId: null,
  pinned: false,
  confidence: 0.8,
  ...extra,
});

let store: MemoryItem[];
let enabled: boolean;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  enabled = true;
  store = [mem("a", "Likes concise answers", { kind: "preference" }), mem("b", "Lives in Berlin")];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const u = new URL(url, "http://x");
    if (method === "GET") {
      const q = u.searchParams.get("q")?.toLowerCase();
      return json({
        enabled,
        memories: store.filter((m) => !q || m.content.toLowerCase().includes(q)),
      });
    }
    const id = u.pathname.split("/")[3];
    if (method === "DELETE" && id) {
      store = store.filter((m) => m.id !== id);
      return json({ deleted: 1 });
    }
    if (method === "DELETE") {
      const n = store.filter((m) => m.sourceQuestId === u.searchParams.get("sourceQuest")).length;
      store = store.filter((m) => m.sourceQuestId !== u.searchParams.get("sourceQuest"));
      return json({ deleted: n });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(init!.body as string);
      store = store.map((m) => (m.id === id ? { ...m, ...patch } : m));
      return json({ memory: store.find((m) => m.id === id) });
    }
    if (method === "POST") {
      store.push(mem("n", JSON.parse(init!.body as string).content, { kind: "preference" }));
      return json({ memory: store.at(-1) }, 201);
    }
    return json({}, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemoryPanel", () => {
  it("renders memories with kind and confidence", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findAllByTestId("memory-item")).toHaveLength(2);
    expect(screen.getByText("Likes concise answers")).toBeTruthy();
    expect(screen.getAllByText("80%").length).toBe(2);
  });

  it("search calls the API with q", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findAllByTestId("memory-item");
    fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "berlin" } });
    await waitFor(() => expect(screen.getAllByTestId("memory-item")).toHaveLength(1));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("q=berlin"))).toBe(true);
  });

  it("delete removes the row", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findAllByTestId("memory-item");
    fireEvent.click(screen.getAllByLabelText("Delete memory")[0]);
    await waitFor(() => expect(screen.getAllByTestId("memory-item")).toHaveLength(1));
    expect(screen.queryByText("Likes concise answers")).toBeNull();
  });

  it("pin persists via PATCH", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findAllByTestId("memory-item");
    fireEvent.click(screen.getAllByLabelText("Pin memory")[0]);
    await waitFor(() => expect(screen.getByLabelText("Unpin memory")).toBeTruthy());
    expect(store[0].pinned).toBe(true);
  });

  it("inline edit saves new content", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findAllByTestId("memory-item");
    fireEvent.click(screen.getAllByLabelText("Edit memory text")[1]);
    fireEvent.change(screen.getByLabelText("Edit memory"), { target: { value: "Lives in Paris" } });
    fireEvent.click(screen.getByText("Save"));
    await screen.findByText("Lives in Paris");
    expect(store[1].content).toBe("Lives in Paris");
  });

  it("adds a memory", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findAllByTestId("memory-item");
    fireEvent.click(screen.getByText("＋ Add memory"));
    fireEvent.change(screen.getByLabelText("New memory"), { target: { value: "Be brief" } });
    fireEvent.click(screen.getByText("Save"));
    await screen.findByText("Be brief");
  });

  it("forgets quest memory when a quest exists", async () => {
    store.push(mem("c", "From quest", { sourceQuestId: "q1" }));
    render(<MemoryPanel questId="q1" onClose={() => {}} />);
    await screen.findByText("From quest");
    fireEvent.click(screen.getByText("Forget quest memory"));
    await waitFor(() => expect(screen.queryByText("From quest")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toContain("Forgot 1 memory");
  });

  it("shows empty and disabled states", async () => {
    store = [];
    enabled = false;
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
    expect(screen.getByTestId("memory-disabled").textContent).toContain("MEMORY_ENABLED=false");
    expect(screen.queryByText("＋ Add memory")).toBeNull();
  });
});
