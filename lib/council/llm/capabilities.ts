export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

interface ModelCaps {
  vision: boolean;
  pdf: boolean;
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Static fallback, first matching rule wins. Text-only unless the endpoint says otherwise. */
const FALLBACK: Array<{ re: RegExp; caps: ModelCaps }> = [
  { re: /^anthropic\/claude/i, caps: { vision: true, pdf: true } },
  { re: /^google\/gemini/i, caps: { vision: true, pdf: true } },
  { re: /^x-ai\/grok-(4|vision)/i, caps: { vision: true, pdf: false } },
  { re: /^openai\/(gpt|o\d|chatgpt)/i, caps: { vision: true, pdf: true } },
  { re: /^deepseek\//i, caps: { vision: false, pdf: false } },
  { re: /^moonshotai\/kimi/i, caps: { vision: false, pdf: false } },
  { re: /^qwen\//i, caps: { vision: false, pdf: false } },
];

let live: Map<string, ModelCaps> | undefined;
let loading: Promise<void> | undefined;
let fetchImpl: FetchLike | undefined;

/** Injects a fetch (tests) and resets the in-memory cache. */
export function setCapabilitiesFetch(f: FetchLike | undefined): void {
  fetchImpl = f;
  resetCapabilities();
}

export function resetCapabilities(): void {
  live = undefined;
  loading = undefined;
}

/**
 * Fetches OpenRouter model metadata once (architecture.input_modalities) and caches it.
 * Never throws; on failure the static fallback list is used.
 */
export function loadCapabilities(): Promise<void> {
  if (live) return Promise.resolve();
  if (loading) return loading;
  const f =
    fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
  if (!f) return Promise.resolve();
  loading = (async () => {
    try {
      const res = await f(MODELS_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }>;
      };
      const map = new Map<string, ModelCaps>();
      for (const m of body.data ?? []) {
        const mods = m.architecture?.input_modalities;
        if (!m.id || !Array.isArray(mods)) continue;
        map.set(m.id, { vision: mods.includes("image"), pdf: mods.includes("file") });
      }
      if (map.size > 0) live = map;
    } catch {
      /* offline: fall back to static list */
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

function lookup(modelId: string): ModelCaps {
  const id = modelId.replace(/:online$/, "");
  const hit = live?.get(id);
  if (hit) return hit;
  return FALLBACK.find((r) => r.re.test(id))?.caps ?? { vision: false, pdf: false };
}

/** Sync: uses live metadata if already loaded (see loadCapabilities), else the static list. */
export function supportsVision(modelId: string): boolean {
  return lookup(modelId).vision;
}

/**
 * PDFs work with any model via OpenRouter's file-parser plugin only when the engine
 * extracts text; here we report native-ish capability (file modality / known families).
 */
export function supportsPdf(modelId: string): boolean {
  return lookup(modelId).pdf;
}
