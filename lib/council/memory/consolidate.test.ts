import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db";
import { MockLLMClient } from "../llm";
import {
  consolidateMemories,
  listMemoryOps,
  memorySources,
  resetConsolidationState,
} from "./consolidate";
import { embedText, vectorToBlob } from "./embeddings";
import { count, getMemory, insertMemory, sqliteOf } from "./store";

let db: DB;
let llm: MockLLMClient;
const deps = () => ({ db, llm });
const DAY = 86_400_000;
const add = async (content: string, extra: Record<string, unknown> = {}) =>
  (await insertMemory({ kind: "fact", content, confidence: 0.8, ...extra }, deps()))!.memory;
const age = (id: string, days: number) =>
  sqliteOf(deps())
    .prepare("UPDATE memories SET created_at = ?, last_used_at = NULL WHERE id = ?")
    .run(Date.now() - days * DAY, id);

beforeEach(() => {
  db = createDb(":memory:");
  llm = new MockLLMClient("merged note");
  resetConsolidationState();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEMORY_CONSOLIDATE;
  delete process.env.MEMORY_DECAY_DAYS;
});

describe("consolidate", () => {
  it("merges near-duplicate clusters keeping best row and provenance union", async () => {
    // Raw inserts bypass insert-time dedupe (which would already merge these).
    const raw = async (id: string, content: string, q: string, conf: number) => {
      const v = (await embedText(content, { llm }))!;
      sqliteOf(deps())
        .prepare(
          "INSERT INTO memories (id, kind, content, embedding, source_quest_id, confidence, created_at) VALUES (?, 'fact', ?, ?, ?, ?, ?)",
        )
        .run(id, content, vectorToBlob(v), q, conf, Date.now());
    };
    await raw("a", "alpha beta gamma delta epsilon zeta eta theta", "q1", 0.6);
    await raw("b", "alpha beta gamma delta epsilon zeta eta theta iota", "q2", 0.9);
    await raw("c", "completely unrelated topic about tariffs", "q3", 0.9);
    const res = await consolidateMemories(deps(), { force: true });
    expect(res).toMatchObject({ ran: true, merged: 1 });
    expect(count(deps())).toBe(2);
    expect(getMemory("a", deps())).toBeNull();
    const keep = getMemory("b", deps())!; // higher confidence wins
    expect(keep.content).toBe("merged note");
    expect(keep.confidence).toBe(0.9);
    expect(memorySources("b", deps()).sort()).toEqual(["q1", "q2"]);
    expect(getMemory("c", deps())!.content).toContain("tariffs");
    expect(llm.calls.filter((c) => c.maxTokens === 600)).toHaveLength(1);
    const ops = listMemoryOps(10, deps()).map((o) => o.op);
    expect(ops).toContain("merge");
    expect(ops).toContain("run");
  });

  it("decays unused unpinned memories once per period; pinned immune", async () => {
    const a = await add("old unused fact about widgets");
    const p = await add("pinned old fact about gadgets entirely different", { pinned: true });
    age(a.id, 90);
    age(p.id, 90);
    const r1 = await consolidateMemories(deps(), { force: true });
    expect(r1.decayed).toBe(1);
    expect(getMemory(a.id, deps())!.confidence).toBeCloseTo(0.7);
    expect(getMemory(p.id, deps())!.confidence).toBeCloseTo(0.8);
    const r2 = await consolidateMemories(deps(), { force: true });
    expect(r2.decayed).toBe(0);
    expect(getMemory(a.id, deps())!.confidence).toBeCloseTo(0.7);
    expect(listMemoryOps(10, deps()).some((o) => o.op === "decay" && o.memoryId === a.id)).toBe(true);
  });

  it("floors at 0.2, deletes rows already below 0.15, spares recently used", async () => {
    const floor = await add("floor candidate memory one", { confidence: 0.25 });
    const dead = await add("dead memory two zebra quartz", { confidence: 0.1 });
    const fresh = await add("fresh memory three violin harbor", { confidence: 0.5 });
    age(floor.id, 70);
    age(dead.id, 70);
    sqliteOf(deps())
      .prepare("UPDATE memories SET last_used_at = ? WHERE id = ?")
      .run(Date.now() - 5 * DAY, fresh.id);
    await consolidateMemories(deps(), { force: true });
    expect(getMemory(floor.id, deps())!.confidence).toBeCloseTo(0.2);
    expect(getMemory(dead.id, deps())).toBeNull();
    expect(getMemory(fresh.id, deps())!.confidence).toBeCloseTo(0.5);
  });

  it("honours MEMORY_DECAY_DAYS and the daily gate", async () => {
    const a = await add("some unused fact about rivers");
    age(a.id, 10);
    process.env.MEMORY_DECAY_DAYS = "5";
    expect((await consolidateMemories(deps())).ran).toBe(true); // first run today
    expect(getMemory(a.id, deps())!.confidence).toBeCloseTo(0.7);
    expect((await consolidateMemories(deps())).ran).toBe(false); // gated
  });

  it("is a no-op when MEMORY_CONSOLIDATE=false", async () => {
    const a = await add("old fact about moons");
    age(a.id, 90);
    process.env.MEMORY_CONSOLIDATE = "false";
    expect(await consolidateMemories(deps(), { force: true })).toMatchObject({ ran: false });
    expect(getMemory(a.id, deps())!.confidence).toBeCloseTo(0.8);
    expect(listMemoryOps(10, deps())).toHaveLength(0);
  });
});
