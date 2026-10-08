// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useQuestStream } from "@/hooks/useQuestStream";
import { MOCK_PLAN } from "./mock-data";

class FakeES {
  onmessage = null;
  onerror = null;
  onopen = null;
  readyState = 1;
  close() {}
}

beforeEach(() => vi.stubGlobal("EventSource", FakeES));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useQuestStream upload flow", () => {
  it("uploads then creates the quest with attachmentIds", async () => {
    const fetchMock = vi.fn(async (...args: [string, RequestInit?]) =>
      args[0] === "/api/uploads"
        ? Response.json({ attachments: [{ id: "u1" }, { id: "u2" }] }, { status: 201 })
        : Response.json({ questId: "q1", plan: MOCK_PLAN }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuestStream());
    const files = [new File(["x"], "a.md"), new File(["y"], "b.md")];
    let ok = false;
    await act(async () => {
      ok = await result.current.start("hello", files);
    });
    expect(ok).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/uploads", "/api/quests"]);
    const upInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((upInit.body as FormData).getAll("files")).toHaveLength(2);
    const qInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(qInit.body))).toEqual({ query: "hello", attachmentIds: ["u1", "u2"] });
    expect(result.current.state.questId).toBe("q1");
    expect(result.current.uploading).toBe(false);
  });

  it("surfaces upload errors (415) and does not create a quest", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "Unsupported file type" }, { status: 415 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuestStream());
    let ok = true;
    await act(async () => {
      ok = await result.current.start("", [new File(["x"], "a.md")]);
    });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.connectionError).toBe("Unsupported file type");
  });

  it("surfaces 413 from quest creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Too large" }, { status: 413 })),
    );
    const { result } = renderHook(() => useQuestStream());
    await act(async () => {
      await result.current.start("q");
    });
    expect(result.current.connectionError).toBe("Too large");
  });
});
