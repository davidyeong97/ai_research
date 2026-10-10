import { asc, eq } from "drizzle-orm";
import { listSessionAttachments } from "@/lib/council/attachments";
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

/** Sum of per-turn search costs recorded on SPEAKING events. */
export function totalSearchCost(events: CouncilEvent[]): number {
  let n = 0;
  for (const e of events) {
    const c = (e.data as Record<string, unknown> | undefined)?.searchCostUsd;
    if (typeof c === "number" && Number.isFinite(c)) n += c;
  }
  return n;
}

export function toMarkdown(
  session: typeof schema.sessions.$inferSelect,
  plan: typeof schema.orchestrationPlans.$inferSelect | undefined,
  events: CouncilEvent[],
  attachments: { filename: string; kind: string; sizeBytes: number }[] = [],
): string {
  const roles = new Map<string, string>();
  const out: string[] = [`# ${session.query}`, ""];
  out.push(`- Status: ${session.status}`, `- Quest: ${session.id}`, "");
  if (attachments.length) {
    out.push("## Attachments", "");
    for (const a of attachments) out.push(`- ${a.filename} (${a.kind}, ${a.sizeBytes} bytes)`);
    out.push("");
  }
  if (plan) {
    const agents = (Array.isArray(plan.agentMatrix) ? plan.agentMatrix : []) as AgentLike[];
    out.push(
      "## Plan",
      "",
      `- Complexity: ${plan.complexity}`,
      `- Rounds: ${plan.rounds}`,
      "- Agents:",
    );
    for (const a of agents) {
      if (a.id) roles.set(a.id, a.role ?? a.id);
      out.push(`  - ${a.role ?? a.id ?? "agent"} (${a.id ?? "?"}): ${a.model ?? "default model"}`);
    }
    out.push("");
  }
  const recalled = events.filter((e) => e.action === "RECALL");
  if (recalled.length) {
    out.push("## Recalled memory", "");
    for (const e of recalled) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(d.ids) ? d.ids : [];
      const kinds = Array.isArray(d.kinds) ? d.kinds : [];
      const previews = Array.isArray(d.preview) ? d.preview : [];
      previews.forEach((p, i) => {
        const text = String(p).replace(/\s+/g, " ").trim();
        out.push(`- [${str(kinds[i]) ?? "memory"}] ${text}${str(ids[i]) ? ` (${ids[i]})` : ""}`);
      });
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
      if (d.userQuery) continue;
      if (d.attachmentDigest) line = `**[attachment digest]** ${msg}`;
      else if (d.guidance) line = `**[director guidance]** ${msg}`;
      else if (d.factCheck) line = `**[fact-check] ${who}:** ${msg}`;
      else line = `**${who}:** ${msg}`;
      const qs = Array.isArray(d.searchQueries)
        ? d.searchQueries.filter((q): q is string => typeof q === "string" && q !== "")
        : [];
      if (qs.length) {
        const sc = typeof d.searchCostUsd === "number" ? ` ($${d.searchCostUsd.toFixed(4)})` : "";
        line += `\n\n_🔎 searched: ${qs.map((q) => q.replace(/\s+/g, " ")).join(" · ")}${sc}_`;
      }
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
    `- Search cost (USD): $${totalSearchCost(events).toFixed(4)}`,
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
  const attachments = listSessionAttachments(id, db).map((a) => ({
    id: a.id,
    filename: a.filename,
    kind: a.kind,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
  }));
  if (format === "json") {
    const agentMessages = db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, id))
      .orderBy(asc(schema.agentMessages.id))
      .all();
    const recalledMemoryIds = [
      ...new Set(
        events
          .filter((e) => e.action === "RECALL")
          .flatMap((e) => {
            const ids = (e.data as Record<string, unknown> | undefined)?.ids;
            return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
          }),
      ),
    ];
    const searchQueriesByTurn = events.flatMap((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (!Array.isArray(d.searchQueries) || !d.searchQueries.length) return [];
      return [
        {
          eventId: e.id,
          round: e.round,
          agentId: e.agentId,
          searchQueries: d.searchQueries.filter((q): q is string => typeof q === "string"),
          searchCostUsd: typeof d.searchCostUsd === "number" ? d.searchCostUsd : 0,
          searchProvider: typeof d.searchProvider === "string" ? d.searchProvider : undefined,
        },
      ];
    });
    return JSON.stringify(
      {
        session,
        plan: plan ?? null,
        attachments,
        recalledMemoryIds,
        events,
        agentMessages,
        searchQueriesByTurn,
        totalSearchCostUsd: totalSearchCost(events),
      },
      null,
      2,
    );
  }
  return toMarkdown(session, plan, events, attachments);
}
