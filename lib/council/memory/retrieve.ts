import { memoryEnabled, memoryMaxInjectChars, memoryRecallK } from "./config";
import { cosine, embedText } from "./embeddings";
import { ftsQuery, loadVectors, sqliteOf, type MemoryDeps, type MemoryKind } from "./store";

export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  score: number;
}

const CANDIDATES = 20;
const RRF_K = 60;
const MIN_CONFIDENCE = 0.3;
/** Cosine below this is considered unrelated and never enters the vector ranking. */
const MIN_COSINE = 0.2;

/**
 * Hybrid retrieval: FTS5 bm25 top 20 + cosine top 20, merged by reciprocal rank.
 * Falls back to FTS-only when embeddings are unavailable. Returns [] when
 * MEMORY_ENABLED=false. Total content never exceeds MEMORY_MAX_INJECT_CHARS.
 */
export async function retrieve(
  query: string,
  opts: MemoryDeps & { k?: number; maxChars?: number } = {},
): Promise<RecalledMemory[]> {
  if (!memoryEnabled() || !query.trim()) return [];
  const sqlite = sqliteOf(opts);
  const k = opts.k ?? memoryRecallK();
  const maxChars = opts.maxChars ?? memoryMaxInjectChars();
  const scores = new Map<string, number>();
  const add = (ids: string[]) =>
    ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

  const match = ftsQuery(query);
  if (match) {
    const rows = sqlite
      .prepare(
        `SELECT m.id AS id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(match, CANDIDATES) as Array<{ id: string }>;
    add(rows.map((r) => r.id));
  }

  const qv = await embedText(query, { llm: opts.llm });
  if (qv) {
    const ranked = [...loadVectors(sqlite)]
      .map(([id, v]) => [id, cosine(qv, v)] as const)
      .filter(([, s]) => s >= MIN_COSINE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, CANDIDATES);
    add(ranked.map(([id]) => id));
  }
  if (scores.size === 0) return [];

  const ids = [...scores.keys()];
  const rows = sqlite
    .prepare(
      `SELECT id, kind, content, pinned, confidence FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{
    id: string;
    kind: MemoryKind;
    content: string;
    pinned: number;
    confidence: number;
  }>;

  const sorted = rows
    .filter((r) => r.pinned === 1 || r.confidence >= MIN_CONFIDENCE)
    .map((r) => ({ id: r.id, kind: r.kind, content: r.content, score: scores.get(r.id)! }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);

  const out: RecalledMemory[] = [];
  let used = 0;
  for (const m of sorted) {
    const room = maxChars - used;
    if (room <= 0) break;
    if (m.content.length <= room) {
      out.push(m);
      used += m.content.length;
    } else if (out.length === 0) {
      out.push({ ...m, content: m.content.slice(0, room) });
      break;
    } else break;
  }
  return out;
}
