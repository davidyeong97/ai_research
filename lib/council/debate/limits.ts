/**
 * Token limits for debate turns. "Visible" budgets cap the answer text; the reasoning
 * budget is added on top (reasoning tokens are billed as output) so thinking cannot
 * starve the visible answer. All values are env-configurable.
 */
export const DEFAULT_AGENT_MAX_TOKENS = 1500;
export const DEFAULT_SYNTHESIS_MAX_TOKENS = 3000;
export const DEFAULT_SUMMARY_MAX_TOKENS = 1000;
export const DEFAULT_DIGEST_MAX_TOKENS = 1000;
export const DEFAULT_FACT_CHECK_MAX_TOKENS = 1000;
export const DEFAULT_REASONING_MAX_TOKENS = 1024;

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface DebateLimits {
  agent: number;
  synthesis: number;
  summary: number;
  digest: number;
  factCheck: number;
  /** Extra output tokens reserved for model reasoning on every call. */
  reasoning: number;
}

export function debateLimits(env: Env = process.env): DebateLimits {
  return {
    agent: intEnv(env, "AGENT_MAX_TOKENS", DEFAULT_AGENT_MAX_TOKENS),
    synthesis: intEnv(env, "SYNTHESIS_MAX_TOKENS", DEFAULT_SYNTHESIS_MAX_TOKENS),
    summary: intEnv(env, "SUMMARY_MAX_TOKENS", DEFAULT_SUMMARY_MAX_TOKENS),
    digest: intEnv(env, "DIGEST_MAX_TOKENS", DEFAULT_DIGEST_MAX_TOKENS),
    factCheck: intEnv(env, "FACT_CHECK_MAX_TOKENS", DEFAULT_FACT_CHECK_MAX_TOKENS),
    reasoning: intEnv(env, "REASONING_MAX_TOKENS", DEFAULT_REASONING_MAX_TOKENS),
  };
}
