import { afterEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../db";
import { EventBus } from "./bus";
import { cacheGet, cacheKey, cacheSet, purgeExpired } from "./cache";
import { runDebate } from "./debate/engine";
import { MockLLMClient } from "./llm";
import type { OrchestrationPlan } from "../shared";

afterEach(() => {
  delete process.env.TOOL_CACHE_ENABLED;
  delete process.env.TOOL_CACHE_TTL_HOURS;
});

const req = { tool: "web_search", maxResults: 3, models: ["a"], messages: [{ role: "user" as const, content: "Hello  World " }] };
const val = { text: "t", citations: [{ url: "https://x.test" }] };

describe("tool cache", () => {
  it("normalizes keys", () => {
    const k = cacheKey(req);
    expect(cacheKey({ ...req, messages: [{ role: "user", content: " hello world" }] })).toBe(k);
    expect(cacheKey({ ...req, maxResults: 4 })).not.toBe(k);
  });
  it("hit, miss, expiry, purge", () => {
    const db = createDb(":memory:");
    expect(cacheGet(db, "k")).toBeUndefined();
    cacheSet(db, "k", val, 1000);
    expect(cacheGet(db, "k", 2000)).toEqual(val);
    cacheSet(db, "old", val, 0);
    expect(purgeExpired(db, 1000 + 25 * 3_600_000)).toBe(2);
    cacheSet(db, "k", val, 1000);
    expect(cacheGet(db, "k", 1000 + 25 * 3_600_000)).toBeUndefined();
  });
  it("respects disabled flag and ttl", () => {
    const db = createDb(":memory:");
    process.env.TOOL_CACHE_ENABLED = "false";
    cacheSet(db, "k", val);
    expect(cacheGet(db, "k")).toBeUndefined();
    process.env.TOOL_CACHE_ENABLED = "true";
    process.env.TOOL_CACHE_TTL_HOURS = "1";
    cacheSet(db, "k", val, 0);
    expect(cacheGet(db, "k", 3_599_000)).toEqual(val);
    expect(cacheGet(db, "k", 3_600_001)).toBeUndefined();
  });
});

describe("engine caching", () => {
  const plan: OrchestrationPlan = {
    taskId: "t",
    complexityScore: 3,
    budgetCapTokens: 30000,
    executionPlan: {
      maxRounds: 1,
      toolsAllowed: ["web_search"],
      assignedAgents: [{ id: "w", role: "wizard", avatar: "wizard", model: "m/a", fallbackModels: [] }],
    },
  };
  async function go(db: ReturnType<typeof createDb>, id: string, llm: MockLLMClient) {
    const bus = new EventBus(db);
    db.insert(schema.sessions).values({ id, query: "Q?", status: "running", createdAt: Date.now() }).run();
    await runDebate({ db, bus, llm }, id, "Q?", plan);
    return bus.replay(id).filter((e) => e.agentId === "w" && e.action === "SPEAKING")[0];
  }
  it("replays cached search turn with zero cost", async () => {
    const db = createDb(":memory:");
    const mk = () =>
      new MockLLMClient({ text: "answer", citations: [{ url: "https://a.test", title: "A" }], usage: { costUsd: 0.01 } });
    const l1 = mk();
    const e1 = await go(db, "q1", l1);
    expect(e1.data.cached).toBeUndefined();
    const l2 = mk();
    const e2 = await go(db, "q2", l2);
    expect(e2.data).toMatchObject({ cached: true, message: "answer", costUsd: 0 });
    expect(e2.data.citations).toEqual([{ url: "https://a.test/", title: "A" }]);
    expect(l2.calls.filter((c) => c.webSearch)).toHaveLength(0);
    expect(l2.calls).toHaveLength(1); // lead synthesis only
  });
});
