export interface SearchResult {
  url: string;
  title: string;
  /** Snippet text. Untrusted web content. */
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string;
  credits: number;
  costUsd: number;
  provider: "tavily";
}

export interface SearchOptions {
  maxResults: number;
  depth: "basic" | "advanced";
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  includeAnswer?: boolean;
  signal?: AbortSignal;
}

export interface SearchProvider {
  name: "tavily";
  search(query: string, opts: SearchOptions): Promise<SearchResponse>;
}

export class SearchError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "SearchError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? opts.status === 429;
  }
}
