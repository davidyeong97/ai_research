import { blob, index, integer, real, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  status: text("status").notNull().default("pending"),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  outcome: text("outcome"),
  source: text("source").notNull().default("web"),
  createdAt: integer("created_at").notNull(),
});

export const orchestrationPlans = sqliteTable("orchestration_plans", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id),
  complexity: integer("complexity").notNull(),
  agentMatrix: text("agent_matrix", { mode: "json" }).notNull(),
  rounds: integer("rounds").notNull(),
});

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    round: integer("round").notNull(),
    agentId: text("agent_id").notNull(),
    actionType: text("action_type").notNull(),
    thoughtLog: text("thought_log"),
    visibleMessage: text("visible_message"),
    tokenCount: integer("token_count").notNull().default(0),
    latencyMs: integer("latency_ms"),
  },
  (t) => [index("agent_messages_session_idx").on(t.sessionId)],
);

export const events = sqliteTable(
  "events",
  {
    questId: text("quest_id").notNull(),
    seq: integer("seq").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.questId, t.seq] })],
);

export const toolCache = sqliteTable("tool_cache", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    kind: text("kind").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("attachments_session_idx").on(t.sessionId)],
);

/** FTS5 table `memories_fts` is created by migrate.ts (not representable in Drizzle). */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["fact", "preference", "summary"] }).notNull(),
    content: text("content").notNull(),
    embedding: blob("embedding", { mode: "buffer" }),
    sourceQuestId: text("source_quest_id"),
    scope: text("scope").notNull().default("default"),
    pinned: integer("pinned").notNull().default(0),
    confidence: real("confidence").notNull().default(0.5),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => [index("memories_kind_created_idx").on(t.kind, t.createdAt)],
);
