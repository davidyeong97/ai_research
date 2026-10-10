import { describe, expect, it } from "vitest";
import { TavilyClient } from "./tavily";

// Skipped unless TAVILY_API_KEY is set in the environment. Performs one real basic search (1 credit).
describe.skipIf(!process.env.TAVILY_API_KEY)("Tavily live check", () => {
  it("performs one real basic search and parses results", async () => {
    const res = await new TavilyClient().search("What is the Next.js framework?", {
      maxResults: 2,
      depth: "basic",
    });
    expect(res.provider).toBe("tavily");
    expect(res.credits).toBeGreaterThanOrEqual(1);
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(typeof r.content).toBe("string");
    }
  });
});
