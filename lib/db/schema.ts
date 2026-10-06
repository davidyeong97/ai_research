import { index, integer, real, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  status: text("status").notNull().default("pending"),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  outcome: text("outcome"),
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
