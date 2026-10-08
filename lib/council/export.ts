import { asc, eq } from "drizzle-orm";
import { schema, type DB } from "@/lib/db";
import type { CouncilEvent } from "@/lib/shared";

interface AgentLike {
  id?: string;
  role?: string;
  model?: string;
  fallbackModels?: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function toMarkdown(
  session: typeof schema.sessions.$inferSelect,
  plan: typeof schema.orchestrationPlans.$inferSelect | undefined,
  events: CouncilEvent[],
): string {
  const roles = new Map<string, string>();
  const out: string[] = [`# ${session.query}`, ""];
  out.push(`- Status: ${session.status}`, `- Quest: ${session.id}`, "");
  if (plan) {
    const agents = (Array.isArray(plan.agentMatrix) ? plan.agentMatrix : []) as AgentLike[];
    out.push("## Plan", "", `- Complexity: ${plan.complexity}`, `- Rounds: ${plan.rounds}`, "- Agents:");
    for (const a of agents) {
      if (a.id) roles.set(a.id, a.role ?? a.id);
      out.push(`  - ${a.role ?? a.id ?? "agent"} (${a.id ?? "?"}): ${a.model ?? "default model"}`);
    }
    out.push("");
  }
  out.push("## Transcript", "");
  let round = 0;
  let final = session.outcome ?? undefined;
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const who = roles.get(e.agentId) ?? e.agentId;
    let line: string | undefined;
    if (e.action === "FALLBACK") {
      line = `_[fallback] ${who}: ${str(d.primary) ?? "primary"} -> ${str(d.modelUsed) ?? "backup"}_`;
    } else if (e.action === "FACT_CHECKING") {
      line = `_[fact-check] ${str(d.statusMessage) ?? "Fact-checking"}_`;
    } else if (e.action === "SPEAKING" || e.action === "CONSENSUS") {
      const msg = str(d.message);
      if (!msg) continue;
      if (d.guidance) line = `**[director guidance]** ${msg}`;
      else if (d.factCheck) line = `**[fact-check] ${who}:** ${msg}`;
      else line = `**${who}:** ${msg}`;
    } else if (e.action === "DONE") {
      final = str(d.finalAnswer) ?? final;
      continue;
    } else if (e.action === "ERROR") {
      line = `_[error] ${str(d.message) ?? str(d.statusMessage) ?? "error"}_`;
    }
    if (!line) continue;
    if (e.round !== round && e.round > 0) {
      round = e.round;
      out.push(`### Round ${round}`, "");
    }
    out.push(line, "");
  }
  if (final) out.push("## Final answer", "", final, "");
  out.push(
    "## Totals",
    "",
    `- Tokens: ${session.totalTokens}`,
    `- Cost (USD): $${session.totalCostUsd.toFixed(4)}`,
    "",
  );
  return out.join("\n");
}

/** Builds the transcript export; returns undefined when the quest does not exist. */
export function buildExport(db: DB, id: string, format: "md" | "json"): string | undefined {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!session) return undefined;
  const plan = db
    .select()
    .from(schema.orchestrationPlans)
    .where(eq(schema.orchestrationPlans.sessionId, id))
    .get();
  const events = db
    .select()
    .from(schema.events)
    .where(eq(schema.events.questId, id))
    .orderBy(asc(schema.events.seq))
    .all()
    .map((r) => r.payload as CouncilEvent);
  if (format === "json") {
    const agentMessages = db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, id))
      .orderBy(asc(schema.agentMessages.id))
      .all();
    return JSON.stringify({ session, plan: plan ?? null, events, agentMessages }, null, 2);
  }
  return toMarkdown(session, plan, events);
}
