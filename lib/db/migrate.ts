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
  // Cross-quest memory. memories_fts is an external-content FTS5 index over
  // memories.content, kept in sync by the triggers below (not by application code).
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact','preference','summary')),
    content TEXT NOT NULL,
    embedding BLOB,
    source_quest_id TEXT,
    scope TEXT NOT NULL DEFAULT 'default',
    pinned INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS memories_kind_created_idx ON memories (kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS memories_source_idx ON memories (source_quest_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, content='memories', content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
];

export function migrate(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    for (const s of STATEMENTS) sqlite.exec(s);
  })();
}
