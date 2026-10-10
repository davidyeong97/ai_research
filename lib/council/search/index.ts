import { TavilyClient } from "./tavily";
import type { SearchProvider } from "./types";

export * from "./types";
export { TavilyClient } from "./tavily";
export { MockSearchProvider } from "./mock";

export type SearchBackend = "tavily" | "openrouter";

const g = globalThis as { __councilSearchProvider?: SearchProvider };

/** Which backend serves agent web search. Explicit WEB_SEARCH_PROVIDER wins; otherwise key presence decides. */
export function searchBackend(): SearchBackend {
  const p = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (p === "openrouter") return "openrouter";
  if (p === "tavily") return process.env.TAVILY_API_KEY?.trim() ? "tavily" : "openrouter";
  return process.env.TAVILY_API_KEY?.trim() ? "tavily" : "openrouter";
}

export function getSearchProvider(): SearchProvider {
  return (g.__councilSearchProvider ??= new TavilyClient());
}

export function setSearchProvider(p: SearchProvider | undefined): void {
  g.__councilSearchProvider = p;
}

export function searchDepth(): "basic" | "advanced" {
  return process.env.TAVILY_SEARCH_DEPTH?.trim().toLowerCase() === "advanced" ? "advanced" : "basic";
}
