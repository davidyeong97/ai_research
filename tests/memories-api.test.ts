import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { setLLMClient } from "@/lib/council/quests";
import { proxy } from "@/proxy";
import { DELETE as delAll, GET, POST } from "@/app/api/memories/route";
import { DELETE as delOne, PATCH } from "@/app/api/memories/[id]/route";
import { MockLLMClient } from "@/lib/council/llm";
import { getMemory, insertMemory } from "@/lib/council/memory/store";

let llm: MockLLMClient;
const g = globalThis as unknown as { __councilDb?: unknown };

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  g.__councilDb = undefined;
  llm = new MockLLMClient();
  setLLMClient(llm);
});
afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.MEMORY_ENABLED;
  delete process.env.APP_PASSWORD;
  g.__councilDb = undefined;
  setLLMClient(undefined);
});

const r = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const seed = (content: string, sourceQuestId: string | null = null) =>
  insertMemory({ kind: "fact", content, confidence: 0.7, sourceQuestId }, { llm });

describe("/api/memories", () => {
  it("auth guard: proxy rejects unauthenticated memory routes", async () => {
    process.env.APP_PASSWORD = "pw";
    expect((await proxy(r("/api/memories"))).status).toBe(401);
    expect((await proxy(r("/api/memories/abc", "DELETE"))).status).toBe(401);
  });

  it("POST adds a preference with confidence 1 and no source", async () => {
    const res = await POST(r("/api/memories", "POST", { content: "I prefer concise answers" }));
    expect(res.status).toBe(201);
    const { memory } = await res.json();
    expect(memory).toMatchObject({ kind: "preference", confidence: 1, sourceQuestId: null });
    expect((await POST(r("/api/memories", "POST", { content: "  " }))).status).toBe(400);
  });

  it("GET lists, filters by kind and searches by FTS q", async () => {
    await seed("Tariffs affect quarterly revenue");
    await POST(r("/api/memories", "POST", { content: "I prefer concise answers" }));
    const all = await (await GET(r("/api/memories"))).json();
    expect(all.enabled).toBe(true);
    expect(all.memories).toHaveLength(2);
    const prefs = await (await GET(r("/api/memories?kind=preference"))).json();
    expect(prefs.memories).toHaveLength(1);
    const q = await (await GET(r("/api/memories?q=tariffs"))).json();
    expect(q.memories.map((m: { content: string }) => m.content)).toEqual([
      "Tariffs affect quarterly revenue",
    ]);
    expect((await GET(r("/api/memories?kind=bogus"))).status).toBe(400);
  });

  it("PATCH pins, changes kind, and re-embeds on content change", async () => {
    const m = (await seed("Original note about databases"))!.memory;
    const before = llm.embedCalls.length;
    let res = await PATCH(r(`/api/memories/${m.id}`, "PATCH", { pinned: true, kind: "summary" }), ctx(m.id));
    expect((await res.json()).memory).toMatchObject({ pinned: true, kind: "summary" });
    expect(llm.embedCalls.length).toBe(before);
    res = await PATCH(r(`/api/memories/${m.id}`, "PATCH", { content: "Edited note about cooking" }), ctx(m.id));
    expect((await res.json()).memory.content).toBe("Edited note about cooking");
    expect(llm.embedCalls.length).toBe(before + 1);
    const hit = await (await GET(r("/api/memories?q=cooking"))).json();
    expect(hit.memories).toHaveLength(1);
    expect((await PATCH(r("/api/memories/nope", "PATCH", { pinned: true }), ctx("nope"))).status).toBe(404);
    expect((await PATCH(r(`/api/memories/${m.id}`, "PATCH", { kind: "x" }), ctx(m.id))).status).toBe(400);
  });

  it("PATCH rejects an edit that duplicates another memory", async () => {
    await seed("The user lives in Berlin");
    const b = (await seed("Totally unrelated astronomy note"))!.memory;
    const res = await PATCH(
      r(`/api/memories/${b.id}`, "PATCH", { content: "the user lives in berlin" }),
      ctx(b.id),
    );
    expect(res.status).toBe(409);
    expect(getMemory(b.id)!.content).toBe("Totally unrelated astronomy note");
  });

  it("DELETE removes one; DELETE ?sourceQuest forgets a quest", async () => {
    const a = (await seed("Alpha fact from quest one", "q1"))!.memory;
    await seed("Beta zebra fact from quest one", "q1");
    await seed("Gamma elephant fact from quest two", "q2");
    expect((await delOne(r(`/api/memories/${a.id}`, "DELETE"), ctx(a.id))).status).toBe(200);
    expect((await delOne(r(`/api/memories/${a.id}`, "DELETE"), ctx(a.id))).status).toBe(404);
    const res = await delAll(r("/api/memories?sourceQuest=q1", "DELETE"));
    expect((await res.json()).deleted).toBe(1);
    expect((await delAll(r("/api/memories", "DELETE"))).status).toBe(400);
    const left = await (await GET(r("/api/memories"))).json();
    expect(left.memories).toHaveLength(1);
  });

  it("disabled: GET reports enabled=false, POST refused", async () => {
    process.env.MEMORY_ENABLED = "false";
    expect((await (await GET(r("/api/memories"))).json()).enabled).toBe(false);
    expect((await POST(r("/api/memories", "POST", { content: "x y" }))).status).toBe(409);
  });
});
