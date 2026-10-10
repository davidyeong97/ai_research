import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db";
import { searchCacheGet, searchCacheKey, searchCacheSet } from "../cache";
import { MockSearchProvider, SearchError, TavilyClient, searchBackend } from "./index";

const opts = { maxResults: 3, depth: "basic" as const };
const ok = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  for (const k of ["TAVILY_API_KEY", "WEB_SEARCH_PROVIDER", "TAVILY_COST_PER_CREDIT_USD"])
    delete process.env[k];
});

describe("TavilyClient", () => {
  it("sends the expected request and parses results", async () => {
    const f = vi.fn(() =>
      ok({
        answer: "ans",
        results: [
          { title: "T", url: "https://a.test/x", content: "c", score: 0.9, published_date: "2024-01-01" },
        ],
      }),
    );
    const c = new TavilyClient({ apiKey: "sekret", fetch: f as unknown as typeof fetch });
    const r = await c.search("q", { ...opts, timeRange: "week", includeAnswer: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sekret");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "q",
      search_depth: "basic",
      max_results: 3,
      topic: "general",
      time_range: "week",
      include_answer: true,
      include_raw_content: false,
    });
    expect(r).toMatchObject({
      query: "q",
      answer: "ans",
      credits: 1,
      provider: "tavily",
      results: [{ title: "T", url: "https://a.test/x", content: "c", score: 0.9, publishedDate: "2024-01-01" }],
    });
    expect(r.costUsd).toBeCloseTo(0.008);
  });

  it("computes credits and cost", async () => {
    const f = () => ok({ results: [] });
    const c = new TavilyClient({ apiKey: "k", fetch: f as unknown as typeof fetch, costPerCreditUsd: 0.01 });
    expect((await c.search("q", { ...opts, depth: "advanced" })).credits).toBe(2);
    const g = () => ok({ results: [], usage: { credits: 5 } });
    const c2 = new TavilyClient({ apiKey: "k", fetch: g as unknown as typeof fetch, costPerCreditUsd: 0.01 });
    const r = await c2.search("q", opts);
    expect(r.credits).toBe(5);
    expect(r.costUsd).toBeCloseTo(0.05);
  });

  it("filters URLs, dedupes and truncates", async () => {
    const f = () =>
      ok({
        results: [
          { title: "a", url: "javascript:alert(1)", content: "x" },
          { title: "b", url: "ftp://x.test/f", content: "x" },
          { title: "c", url: "not a url", content: "x" },
          { title: "d", url: "https://d.test", content: "y".repeat(5000) },
          { title: "e", url: "https://d.test", content: "dup" },
        ],
      });
    const r = await new TavilyClient({ apiKey: "k", fetch: f as unknown as typeof fetch }).search("q", opts);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].content).toHaveLength(1200);
  });

  it("throws SearchError, 429 retryable, never leaks key", async () => {
    const mk = (status: number) =>
      new TavilyClient({ apiKey: "sekret", fetch: (() => ok({ detail: "no" }, status)) as unknown as typeof fetch });
    const e429 = await mk(429).search("q", opts).catch((e) => e);
    expect(e429).toBeInstanceOf(SearchError);
    expect(e429.status).toBe(429);
    expect(e429.retryable).toBe(true);
    const e401 = await mk(401).search("q", opts).catch((e) => e);
    expect(e401.status).toBe(401);
    expect(e401.retryable).toBe(false);
    expect(e401.message).not.toContain("sekret");
  });

  it("times out", async () => {
    const f = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, rej) =>
        init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
    const c = new TavilyClient({ apiKey: "k", fetch: f as unknown as typeof fetch, timeoutMs: 20 });
    const e = await c.search("q", opts).catch((x) => x);
    expect(e).toBeInstanceOf(SearchError);
    expect(e.message).toMatch(/timed out/);
    expect(e.retryable).toBe(true);
  });

  it("requires an API key", async () => {
    await expect(new TavilyClient().search("q", opts)).rejects.toBeInstanceOf(SearchError);
  });
});

describe("searchBackend", () => {
  it("selects backend", () => {
    expect(searchBackend()).toBe("openrouter");
    process.env.TAVILY_API_KEY = "k";
    expect(searchBackend()).toBe("tavily");
    process.env.WEB_SEARCH_PROVIDER = "openrouter";
    expect(searchBackend()).toBe("openrouter");
    process.env.WEB_SEARCH_PROVIDER = "tavily";
    expect(searchBackend()).toBe("tavily");
    delete process.env.TAVILY_API_KEY;
    expect(searchBackend()).toBe("openrouter");
  });
});

describe("search cache", () => {
  const base = { provider: "tavily", query: "Hello  World", maxResults: 3, depth: "basic" };
  it("normalizes and varies keys", () => {
    const k = searchCacheKey(base);
    expect(searchCacheKey({ ...base, query: " hello world " })).toBe(k);
    expect(searchCacheKey({ ...base, depth: "advanced" })).not.toBe(k);
    expect(searchCacheKey({ ...base, timeRange: "day" })).not.toBe(k);
  });
  it("hit returns zero cost, miss undefined", async () => {
    const db = createDb(":memory:");
    const key = searchCacheKey(base);
    expect(searchCacheGet(db, key)).toBeUndefined();
    const r = await new MockSearchProvider().search("q", opts);
    expect(r.credits).toBe(1);
    searchCacheSet(db, key, r);
    const hit = searchCacheGet(db, key)!;
    expect(hit.results).toEqual(r.results);
    expect(hit.credits).toBe(0);
    expect(hit.costUsd).toBe(0);
    expect(searchCacheGet(db, key, Date.now() + 25 * 3_600_000)).toBeUndefined();
  });
});

describe("MockSearchProvider", () => {
  it("records calls", async () => {
    const m = new MockSearchProvider();
    await m.search("q", opts);
    expect(m.calls).toHaveLength(1);
  });
});
