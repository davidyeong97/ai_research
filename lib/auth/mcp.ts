import { timingSafeEqualStr } from "./session";

export const MCP_PATH = "/api/mcp";
export const MCP_TOKEN_MIN_LENGTH = 32;
const encoder = new TextEncoder();

export function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname === `${MCP_PATH}/`;
}

/** Returns the configured token, or undefined when MCP is disabled (unset or too short). */
export function mcpTokenFromEnv(): string | undefined {
  const t = process.env.MCP_TOKEN?.trim();
  return t && t.length >= MCP_TOKEN_MIN_LENGTH ? t : undefined;
}

export function parseBearer(header: string | null): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m?.[1];
}

async function digest(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time bearer comparison (compares SHA-256 digests so length does not leak). */
export async function bearerMatches(presented: string | undefined, expected: string): Promise<boolean> {
  if (!presented) return false;
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  return timingSafeEqualStr(a, b);
}

// ---- fixed-window rate limit -------------------------------------------------

const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

export function mcpRateLimitMax(): number {
  const n = Number(process.env.MCP_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

/** Returns seconds until the window resets when limited, otherwise 0. */
export function checkMcpRateLimit(key: string, now: number = Date.now()): number {
  const max = mcpRateLimitMax();
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(key, w);
    if (windows.size > 1000) {
      for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
    }
  }
  w.count++;
  return w.count > max ? Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)) : 0;
}

export function resetMcpRateLimit(): void {
  windows.clear();
}
