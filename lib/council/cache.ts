import { createHash } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import { textOf, type ChatMessage, type MessageContent } from "./llm";

export interface CachedToolResult {
  text: string;
  reasoning?: string;
  citations: { url: string; title?: string }[];
  model?: string;
}

export const DEFAULT_TTL_HOURS = 24;

export function cacheEnabled(): boolean {
  const v = process.env.TOOL_CACHE_ENABLED?.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export function cacheTtlMs(): number {
  const n = Number(process.env.TOOL_CACHE_TTL_HOURS);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_HOURS) * 3_600_000;
}

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

const sha = (d: Uint8Array | string) =>
  createHash("sha256")
    .update(typeof d === "string" ? Buffer.from(d, "base64") : d)
    .digest("hex");

/** Normalized text plus a sha256 for every media part, so different media never collide. */
function canonContent(content: MessageContent): [string, ...string[]] {
  const media =
    typeof content === "string"
      ? []
      : content.flatMap((p) =>
          p.type === "text" ? [] : [`${p.type}:${p.mediaType}:${sha(p.data)}`],
        );
  return [norm(textOf(content)), ...media];
}

/** sha256 of the normalized request (tool, maxResults, model list, messages). */
export function cacheKey(req: {
  tool: string;
  maxResults: number;
  models: string[];
  messages: ChatMessage[];
}): string {
  const canonical = JSON.stringify({
    tool: req.tool,
    maxResults: req.maxResults,
    models: req.models,
    messages: req.messages.map((m) => [m.role, ...canonContent(m.content)]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function cacheGet(
  db: DB = getDb(),
  key: string,
  now = Date.now(),
): CachedToolResult | undefined {
  if (!cacheEnabled()) return undefined;
  const row = db.select().from(schema.toolCache).where(eq(schema.toolCache.key, key)).get();
  if (!row) return undefined;
  if (row.expiresAt <= now) {
    db.delete(schema.toolCache).where(eq(schema.toolCache.key, key)).run();
    return undefined;
  }
  return row.value as CachedToolResult;
}

export function cacheSet(
  db: DB = getDb(),
  key: string,
  value: CachedToolResult,
  now = Date.now(),
): void {
  if (!cacheEnabled()) return;
  const expiresAt = now + cacheTtlMs();
  db.insert(schema.toolCache)
    .values({ key, value, createdAt: now, expiresAt })
    .onConflictDoUpdate({ target: schema.toolCache.key, set: { value, createdAt: now, expiresAt } })
    .run();
}

/** Delete expired rows; returns the number removed. */
export function purgeExpired(db: DB = getDb(), now = Date.now()): number {
  return db.delete(schema.toolCache).where(lte(schema.toolCache.expiresAt, now)).run().changes;
}
