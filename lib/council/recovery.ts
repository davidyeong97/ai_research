import { eq, inArray } from "drizzle-orm";
import { getBus, type EventBus } from "./bus";
import { getControl } from "./control";
import { getDb, schema, type DB } from "../db";

export const RESTART_MESSAGE =
  "The server restarted while this quest was running. Please start a new quest.";

/**
 * Marks quests left 'running'/'awaiting_approval' by a previous process as
 * 'interrupted' and emits a terminal ERROR event so SSE clients terminate.
 * Idempotent; returns the number of quests recovered.
 */
export function recoverStrandedQuests(deps: { db?: DB; bus?: EventBus } = {}): number {
  const db = deps.db ?? getDb();
  const bus = deps.bus ?? getBus();
  const stranded = db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(inArray(schema.sessions.status, ["running", "awaiting_approval"]))
    .all()
    .filter((s) => !getControl(s.id));
  for (const { id } of stranded) {
    const round = bus.replay(id).reduce((m, e) => Math.max(m, e.round ?? 0), 0);
    db.update(schema.sessions)
      .set({ status: "interrupted" })
      .where(eq(schema.sessions.id, id))
      .run();
    bus.publish({
      questId: id,
      round,
      agentId: "lead",
      action: "ERROR",
      tokensUsed: 0,
      data: { reason: "server_restarted", message: RESTART_MESSAGE },
    });
  }
  return stranded.length;
}
