import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db";
import { MockLLMClient } from "../llm";
import { retrieve } from "./retrieve";
import {
  count,
  deleteMemory,
  getMemory,
  insertMemory,
  listMemories,
  touchUsed,
  updateMemory,
} from "./store";

let db: DB;
let llm: MockLLMClient;
const deps = () => ({ db, llm });
const add = (content: string, extra: Record<string, unknown> = {}) =>
  insertMemory({ kind: "fact", content, confidence: 0.8, ...extra }, deps());

beforeEach(() => {
  db = createDb(":memory:");
  llm = new MockLLMClient();
});
afterEach(() => {
  delete process.env.MEMORY_ENABLED;
  delete process.env.MEMORY_MAX_ROWS;
});

describe("store", () => {
  it("inserts and reads back", async () => {
    const r = await add("User prefers concise answers", { sourceQuestId: "q1" });
    expect(r?.merged).toBe(false);
    expect(getMemory(r!.memory.id, deps())).toMatchObject({
      kind: "fact",
      sourceQuestId: "q1",
      scope: "default",
      pinned: false,
      useCount: 0,
    });
    expect(count(deps())).toBe(1);
  });

  it("merges exact and near-duplicates (cosine >= 0.9)", async () => {
    const a = await add("The user prefers concise answers with bullet points");
    const exact = await add("  the user prefers CONCISE answers with bullet points ");
    expect(exact).toMatchObject({ merged: true });
    expect(exact!.memory.id).toBe(a!.memory.id);
    expect(exact!.memory.useCount).toBe(1);
    expect(exact!.memory.confidence).toBeCloseTo(0.85);
    const near = await add("The user prefers concise answers with bullet points!");
    expect(near!.merged).toBe(true);
    expect(count(deps())).toBe(1);
  });

  it("does not merge into pinned rows by cosine, nor distinct content", async () => {
    await add("The user prefers concise answers with bullet points", { pinned: true });
    const r = await add("The user prefers concise answers with bullet points!");
    expect(r!.merged).toBe(false);
    const other = await add("Quarterly revenue forecasts depend on tariffs");
    expect(other!.merged).toBe(false);
  });

  it("optional LLM merge rewrites content", async () => {
    await add("Alpha beta gamma delta epsilon zeta");
    llm.enqueue("Merged note");
    const r = await insertMemory(
      { kind: "fact", content: "Alpha beta gamma delta epsilon zeta eta", confidence: 0.7 },
      { ...deps(), mergeWithLlm: true },
    );
    expect(r).toMatchObject({ merged: true });
    expect(r!.memory.content).toBe("Merged note");
    expect(llm.calls).toHaveLength(1);
  });

  it("prunes oldest lowest-confidence unpinned rows beyond MEMORY_MAX_ROWS", async () => {
    process.env.MEMORY_MAX_ROWS = "3";
    const pinned = await add("pinned zzz one", { pinned: true, confidence: 0.1 });
    const low = await add("lowconf qqq two", { confidence: 0.2 });
    await add("highconf www three", { confidence: 0.9 });
    await add("highconf eee four", { confidence: 0.9 });
    expect(count(deps())).toBe(3);
    expect(getMemory(low!.memory.id, deps())).toBeNull();
    expect(getMemory(pinned!.memory.id, deps())).not.toBeNull();
  });

  it("update re-embeds content, delete removes from FTS", async () => {
    const r = await add("apples are red");
    await updateMemory(r!.memory.id, { content: "bananas are yellow", pinned: true }, deps());
    expect(listMemories({ q: "bananas" }, deps())).toHaveLength(1);
    expect(listMemories({ q: "apples" }, deps())).toHaveLength(0);
    expect(getMemory(r!.memory.id, deps())?.pinned).toBe(true);
    const hits = await retrieve("yellow bananas", deps());
    expect(hits[0].id).toBe(r!.memory.id);
    expect(deleteMemory(r!.memory.id, deps())).toBe(true);
    expect(listMemories({ q: "bananas" }, deps())).toHaveLength(0);
    expect(await retrieve("yellow bananas", deps())).toEqual([]);
  });

  it("touchUsed bumps usage", async () => {
    const r = await add("some fact");
    touchUsed([r!.memory.id], deps());
    const m = getMemory(r!.memory.id, deps())!;
    expect(m.useCount).toBe(1);
    expect(m.lastUsedAt).not.toBeNull();
  });

  it("listMemories filters by kind and handles odd q", async () => {
    await insertMemory({ kind: "preference", content: "likes tea" }, deps());
    await add("sky is blue");
    expect(listMemories({ kind: "preference" }, deps())).toHaveLength(1);
    expect(listMemories({ q: '"; DROP --' }, deps())).toHaveLength(0);
  });

  it("is a no-op when MEMORY_ENABLED=false", async () => {
    process.env.MEMORY_ENABLED = "false";
    expect(await add("anything")).toBeNull();
    expect(count(deps())).toBe(0);
    process.env.MEMORY_ENABLED = "true";
    await add("anything at all");
    process.env.MEMORY_ENABLED = "false";
    expect(await retrieve("anything", deps())).toEqual([]);
  });
});

describe("retrieve", () => {
  it("finds keyword (FTS) hits when embeddings fail", async () => {
    await add("Postgres uses MVCC for concurrency");
    await add("Cats sleep a lot");
    llm.embedError = new Error("boom");
    const hits = await retrieve("postgres", deps());
    expect(hits.map((h) => h.content)).toEqual(["Postgres uses MVCC for concurrency"]);
  });

  it("finds cosine hits without keyword overlap in FTS", async () => {
    const r = await add("alpha beta gamma delta");
    // FTS OR-match needs a shared token; cosine alone still ranks it via embedding.
    const hits = await retrieve("alpha beta gamma", deps());
    expect(hits[0].id).toBe(r!.memory.id);
    expect(hits[0].score).toBeGreaterThan(1 / 61); // contributed by both rankers
  });

  it("orders hybrid results by reciprocal rank", async () => {
    const both = await add("rust borrow checker lifetimes explained");
    await add("rust is a metal oxide");
    await add("borrow money from the bank");
    const hits = await retrieve("rust borrow checker lifetimes", deps());
    expect(hits[0].id).toBe(both!.memory.id);
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i++)
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it("drops confidence < 0.3 unless pinned", async () => {
    await add("lowconf topic widgets", { confidence: 0.2 });
    expect(await retrieve("widgets", deps())).toEqual([]);
    const p = await add("pinned topic gadgets", { confidence: 0.2, pinned: true });
    expect((await retrieve("gadgets", deps())).map((h) => h.id)).toEqual([p!.memory.id]);
  });

  it("respects k and the character cap", async () => {
    for (let i = 0; i < 6; i++) await add(`shared topic note number${i} ${"x".repeat(100)}`);
    expect(await retrieve("shared topic note", { ...deps(), k: 2 })).toHaveLength(2);
    const capped = await retrieve("shared topic note", { ...deps(), k: 6, maxChars: 250 });
    expect(capped.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(250);
    expect(capped.length).toBeGreaterThan(0);
    process.env.MEMORY_MAX_INJECT_CHARS = "50";
    const tiny = await retrieve("shared topic note", deps());
    delete process.env.MEMORY_MAX_INJECT_CHARS;
    expect(tiny.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(50);
  });
});
