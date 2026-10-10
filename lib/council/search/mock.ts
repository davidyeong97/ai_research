import type { SearchOptions, SearchProvider, SearchResponse, SearchResult } from "./types";

export class MockSearchProvider implements SearchProvider {
  readonly name = "tavily" as const;
  calls: { query: string; opts: SearchOptions }[] = [];
  /** When set, search() rejects with this error. */
  error?: Error;

  constructor(
    private results: SearchResult[] = [
      { url: "https://example.com/a", title: "Example A", content: "Snippet A" },
      { url: "https://example.com/b", title: "Example B", content: "Snippet B" },
    ],
    private creditsPerCall = 1,
    private costPerCredit = 0.008,
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    this.calls.push({ query, opts });
    if (this.error) throw this.error;
    const credits = opts.depth === "advanced" ? this.creditsPerCall * 2 : this.creditsPerCall;
    return {
      query,
      results: this.results.slice(0, opts.maxResults).map((r) => ({ ...r })),
      credits,
      costUsd: credits * this.costPerCredit,
      provider: "tavily",
    };
  }
}
