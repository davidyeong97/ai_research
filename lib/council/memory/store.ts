import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb, type DB } from "@/lib/db";
import { collectChat, type LLMClient } from "../llm";
import { getLLMClient } from "../quests";
import { memoryEnabled, memoryMaxRows, memoryModel } from "./config";
import { blobToVector, cosine, embedText, vectorToBlob } from "./embeddings";

/**
 * Memory persistence. The FTS5 index `memories_fts` is kept in sync by SQLite
 * triggers defined in lib/db/migrate.ts (insert/delete/update-of-content), so
 * every write path here (and any future raw SQL) stays consistent.
 *
 * MEMORY_ENABLED=false: insertMemory/touchUsed are no-ops. Reads and deletes
 * keep working so the user can still inspect and purge stored memories.
 */

export const MEMORY_KINDS = ["fact", "preference", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceQuestId: string | null;
  scope: string;
  pinned: boolean;
  confidence: number;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export interface MemoryDeps {
  db?: DB;
  llm?: LLMClient;
}

export interface NewMemory {
  kind: MemoryKind;
  content: string;
  confidence?: number;
  sourceQuestId?: string | null;
  scope?: string;
  pinned?: boolean;
}

export interface InsertOptions extends MemoryDeps {
  /** Use the cheap MEMORY_MODEL to rewrite merged content (extra LLM call). Default false. */
  mergeWithLlm?: boolean;
}

export interface InsertResult {
  memory: Memory;
  merged: boolean;
}

/** Cosine similarity at/above which a new memory merges into an existing one. */
export const DEDUPE_COSINE = 0.9;

interface Row {
  id: string;
  kind: MemoryKind;
  content: string;
  source_quest_id: string | null;
  scope: string;
  pinned: number;
  confidence: number;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}

const COLS =
  "id, kind, content, source_quest_id, scope, pinned, confidence, created_at, last_used_at, use_count";

const toMemory = (r: Row): Memory => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  sourceQuestId: r.source_quest_id,
  scope: r.scope,
  pinned: r.pinned === 1,
  confidence: r.confidence,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
});

export const sqliteOf = (deps: MemoryDeps = {}): Database.Database => (deps.db ?? getDb()).$client;

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5));

// ---- in-process vector cache (bounded LRU, per sqlite handle) --------------

const VECTOR_CACHE_MAX = 5000;
const caches = new WeakMap<Database.Database, Map<string, Float32Array>>();

function cacheOf(sqlite: Database.Database): Map<string, Float32Array> {
  let c = caches.get(sqlite);
  if (!c) caches.set(sqlite, (c = new Map()));
  return c;
}

function cacheSet(sqlite: Database.Database, id: string, v: Float32Array | null): void {
  const c = cacheOf(sqlite);
  c.delete(id);
  if (!v) return;
  c.set(id, v);
  if (c.size > VECTOR_CACHE_MAX) c.delete(c.keys().next().value as string);
}

/** Embedding vectors for all embedded rows (optionally only unpinned), loaded lazily. */
export function loadVectors(
  sqlite: Database.Database,
  opts: { unpinnedOnly?: boolean } = {},
): Map<string, Float32Array> {
  const cache = cacheOf(sqlite);
  const where = opts.unpinnedOnly ? "AND pinned = 0" : "";
  const ids = sqlite
    .prepare(`SELECT id FROM memories WHERE embedding IS NOT NULL ${where}`)
    .all() as Array<{ id: string }>;
  const missing = ids.filter((r) => !cache.has(r.id)).map((r) => r.id);
  for (const id of missing) {
    const row = sqlite.prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as
      { embedding: Buffer } | undefined;
    if (row?.embedding) cacheSet(sqlite, id, blobToVector(row.embedding));
  }
  const out = new Map<string, Float32Array>();
  for (const { id } of ids) {
    const v = cache.get(id);
    if (v) {
      out.set(id, v);
      cache.delete(id); // refresh LRU position
      cache.set(id, v);
    }
  }
  return out;
}

// ---- reads -------------------------------------------------------------------

export function getMemory(id: string, deps: MemoryDeps = {}): Memory | null {
  const row = sqliteOf(deps).prepare(`SELECT ${COLS} FROM memories WHERE id = ?`).get(id) as
    Row | undefined;
  return row ? toMemory(row) : null;
}

export function count(deps: MemoryDeps = {}): number {
  return (sqliteOf(deps).prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
}

/** Builds a safe FTS5 MATCH expression (OR of quoted tokens) or null if no usable tokens. */
export function ftsQuery(q: string): string | null {
  const toks = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32);
  return toks.length ? toks.map((t) => `"${t}"`).join(" OR ") : null;
}

export function listMemories(
  opts: { kind?: MemoryKind; q?: string; limit?: number; sourceQuestId?: string } = {},
  deps: MemoryDeps = {},
): Memory[] {
  const sqlite = sqliteOf(deps);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    where.push("m.kind = ?");
    params.push(opts.kind);
  }
  if (opts.sourceQuestId) {
    where.push("m.source_quest_id = ?");
    params.push(opts.sourceQuestId);
  }
  const cols = COLS.split(", ")
    .map((c) => `m.${c}`)
    .join(", ");
  if (opts.q?.trim()) {
    const match = ftsQuery(opts.q);
    if (!match) return [];
    where.push("m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
    params.push(match);
  }
  const sql = `SELECT ${cols} FROM memories m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.pinned DESC, m.created_at DESC LIMIT ?`;
  return (sqlite.prepare(sql).all(...params, limit) as Row[]).map(toMemory);
}

// ---- writes ------------------------------------------------------------------

async function llmMerge(oldText: string, newText: string, llm: LLMClient): Promise<string | null> {
  try {
    const { text } = await collectChat(
      llm.streamChat({
        models: [memoryModel()],
        maxTokens: 200,
        messages: [
          {
            role: "system",
            content:
              "Merge two near-duplicate memory notes into one concise note that keeps all durable information. Reply with the merged note only.",
          },
          { role: "user", content: `A: ${oldText}\nB: ${newText}` },
        ],
      }),
    );
    const merged = text.trim();
    return merged ? merged.slice(0, 1000) : null;
  } catch {
    return null;
  }
}

export async function insertMemory(
  input: NewMemory,
  opts: InsertOptions = {},
): Promise<InsertResult | null> {
  if (!memoryEnabled()) return null;
  const content = input.content.trim();
  if (!content || !MEMORY_KINDS.includes(input.kind)) return null;
  const sqlite = sqliteOf(opts);
  const confidence = clamp01(input.confidence ?? 0.5);
  const vec = await embedText(content, { llm: opts.llm });

  // Dedupe: exact (case/space-insensitive) match, else cosine >= 0.90 vs unpinned rows.
  let dupId: string | null = null;
  const exact = sqlite
    .prepare("SELECT id FROM memories WHERE lower(trim(content)) = lower(?) LIMIT 1")
    .get(content) as { id: string } | undefined;
  if (exact) dupId = exact.id;
  else if (vec) {
    let best = DEDUPE_COSINE;
    for (const [id, v] of loadVectors(sqlite, { unpinnedOnly: true })) {
      const s = cosine(vec, v);
      if (s >= best) {
        best = s;
        dupId = id;
      }
    }
  }

  if (dupId) {
    const existing = getMemory(dupId, opts)!;
    let newContent = existing.content;
    if (opts.mergeWithLlm && newContent.trim().toLowerCase() !== content.toLowerCase()) {
      newContent =
        (await llmMerge(existing.content, content, opts.llm ?? getLLMClient())) ?? newContent;
    }
    const bumped = clamp01(Math.max(existing.confidence, confidence) + 0.05);
    sqlite
      .prepare(
        "UPDATE memories SET confidence = ?, use_count = use_count + 1, content = ? WHERE id = ?",
      )
      .run(bumped, newContent, dupId);
    if (newContent !== existing.content) {
      const nv = await embedText(newContent, { llm: opts.llm });
      sqlite
        .prepare("UPDATE memories SET embedding = ? WHERE id = ?")
        .run(nv ? vectorToBlob(nv) : null, dupId);
      cacheSet(sqlite, dupId, nv);
    }
    return { memory: getMemory(dupId, opts)!, merged: true };
  }

  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO memories (id, kind, content, embedding, source_quest_id, scope, pinned, confidence, created_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.kind,
      content,
      vec ? vectorToBlob(vec) : null,
      input.sourceQuestId ?? null,
      input.scope ?? "default",
      input.pinned ? 1 : 0,
      confidence,
      Date.now(),
    );
  cacheSet(sqlite, id, vec);
  prune(opts);
  // Pruning never removes pinned rows, so the new row may only vanish if it is the weakest unpinned.
  const memory = getMemory(id, opts);
  return memory ? { memory, merged: false } : null;
}

/** Deletes oldest/lowest-confidence unpinned rows beyond MEMORY_MAX_ROWS. Returns rows removed. */
export function prune(deps: MemoryDeps = {}): number {
  const sqlite = sqliteOf(deps);
  const excess = count(deps) - memoryMaxRows();
  if (excess <= 0) return 0;
  const victims = sqlite
    .prepare(
      "SELECT id FROM memories WHERE pinned = 0 ORDER BY confidence ASC, created_at ASC, rowid ASC LIMIT ?",
    )
    .all(excess) as Array<{ id: string }>;
  for (const { id } of victims) {
    sqlite.prepare("DELETE FROM memories WHERE id = ?").run(id);
    cacheSet(sqlite, id, null);
  }
  return victims.length;
}

export class DuplicateMemoryError extends Error {
  constructor(public readonly existingId: string) {
    super("A similar memory already exists");
  }
}

export async function updateMemory(
  id: string,
  patch: { content?: string; pinned?: boolean; kind?: MemoryKind; confidence?: number },
  deps: MemoryDeps & { rejectDuplicates?: boolean } = {},
): Promise<Memory | null> {
  const sqlite = sqliteOf(deps);
  const existing = getMemory(id, deps);
  if (!existing) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.kind !== undefined && MEMORY_KINDS.includes(patch.kind)) {
    sets.push("kind = ?");
    params.push(patch.kind);
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(clamp01(patch.confidence));
  }
  const content = patch.content?.trim();
  let vec: Float32Array | null | undefined;
  if (content && content !== existing.content) {
    vec = await embedText(content, { llm: deps.llm });
    if (deps.rejectDuplicates) {
      const exact = sqlite
        .prepare(
          "SELECT id FROM memories WHERE lower(trim(content)) = lower(?) AND id != ? LIMIT 1",
        )
        .get(content, id) as { id: string } | undefined;
      let dup = exact?.id ?? null;
      if (!dup && vec) {
        for (const [oid, v] of loadVectors(sqlite)) {
          if (oid !== id && cosine(vec, v) >= DEDUPE_COSINE) {
            dup = oid;
            break;
          }
        }
      }
      if (dup) throw new DuplicateMemoryError(dup);
    }
    sets.push("content = ?", "embedding = ?");
    params.push(content, vec ? vectorToBlob(vec) : null);
  }
  if (sets.length)
    sqlite.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  if (vec !== undefined) cacheSet(sqlite, id, vec);
  return getMemory(id, deps);
}

export function deleteMemory(id: string, deps: MemoryDeps = {}): boolean {
  const sqlite = sqliteOf(deps);
  const res = sqlite.prepare("DELETE FROM memories WHERE id = ?").run(id);
  cacheSet(sqlite, id, null);
  return res.changes > 0;
}

/** Deletes all memories extracted from a quest; returns the number removed. */
export function deleteBySourceQuest(questId: string, deps: MemoryDeps = {}): number {
  const sqlite = sqliteOf(deps);
  const ids = sqlite
    .prepare("SELECT id FROM memories WHERE source_quest_id = ?")
    .all(questId) as Array<{ id: string }>;
  for (const { id } of ids) deleteMemory(id, deps);
  return ids.length;
}

export function touchUsed(ids: string[], deps: MemoryDeps = {}): void {
  if (!memoryEnabled() || ids.length === 0) return;
  const stmt = sqliteOf(deps).prepare(
    "UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
  );
  const now = Date.now();
  for (const id of ids) stmt.run(now, id);
}
