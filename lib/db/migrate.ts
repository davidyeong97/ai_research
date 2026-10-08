import type Database from "better-sqlite3";

/** Idempotent schema creation; keep in sync with schema.ts. */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    query TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    outcome TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orchestration_plans (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
    complexity INTEGER NOT NULL,
    agent_matrix TEXT NOT NULL,
    rounds INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    round INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    thought_log TEXT,
    visible_message TEXT,
    token_count INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS agent_messages_session_idx ON agent_messages (session_id)`,
  `CREATE TABLE IF NOT EXISTS events (
    quest_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (quest_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_cache (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tool_cache_expires_idx ON tool_cache (expires_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT REFERENCES sessions(id),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attachments_session_idx ON attachments (session_id)`,
];

export function migrate(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    for (const s of STATEMENTS) sqlite.exec(s);
  })();
}
