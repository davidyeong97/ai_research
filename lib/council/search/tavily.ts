import { SearchError } from "./types";
import type { SearchOptions, SearchProvider, SearchResponse, SearchResult } from "./types";

const ENDPOINT = "https://api.tavily.com/search";
const SNIPPET_MAX = 1200;

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface TavilyClientOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  costPerCreditUsd?: number;
}

export class TavilyClient implements SearchProvider {
  readonly name = "tavily" as const;
  private readonly apiKey?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly costPerCredit?: number;

  constructor(o: TavilyClientOptions = {}) {
    this.apiKey = o.apiKey;
    this.fetchImpl = o.fetch;
    this.timeoutMs = o.timeoutMs;
    this.costPerCredit = o.costPerCreditUsd;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const key = this.apiKey ?? process.env.TAVILY_API_KEY?.trim();
    if (!key) throw new SearchError("TAVILY_API_KEY is not set", { retryable: false });
    const timeoutMs = this.timeoutMs ?? envNum("TAVILY_TIMEOUT_MS", 15000);
    const costPerCredit = this.costPerCredit ?? envNum("TAVILY_COST_PER_CREDIT_USD", 0.008);
    const body: Record<string, unknown> = {
      query,
      search_depth: opts.depth,
      max_results: opts.maxResults,
      topic: opts.topic ?? "general",
      include_answer: opts.includeAnswer ?? false,
      include_raw_content: false,
    };
    if (opts.timeRange) body.time_range = opts.timeRange;

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.fetchImpl ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (timeout.aborted) {
        throw new SearchError(`Tavily search timed out after ${timeoutMs}ms`, { retryable: true });
      }
      if (opts.signal?.aborted) throw e;
      throw new SearchError("Tavily request failed (network error)", { retryable: true });
    }
    if (!res.ok) {
      throw new SearchError(`Tavily search failed with HTTP ${res.status}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new SearchError("Tavily returned invalid JSON", { status: res.status });
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const rawCredits = (d.usage as { credits?: unknown } | undefined)?.credits;
    const credits =
      typeof rawCredits === "number" && Number.isFinite(rawCredits) && rawCredits >= 0
        ? rawCredits
        : opts.depth === "advanced"
          ? 2
          : 1;
    return {
      query,
      results: parseResults(d.results),
      ...(typeof d.answer === "string" && d.answer ? { answer: d.answer } : {}),
      credits,
      costUsd: credits * costPerCredit,
      provider: "tavily",
    };
  }
}

function parseResults(raw: unknown): SearchResult[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.url !== "string") continue;
    let u: URL;
    try {
      u = new URL(o.url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    const item: SearchResult = {
      url: o.url,
      title: typeof o.title === "string" ? o.title : "",
      content: (typeof o.content === "string" ? o.content : "").slice(0, SNIPPET_MAX),
    };
    if (typeof o.score === "number") item.score = o.score;
    if (typeof o.published_date === "string" && o.published_date) {
      item.publishedDate = o.published_date;
    }
    out.push(item);
  }
  return out;
}
