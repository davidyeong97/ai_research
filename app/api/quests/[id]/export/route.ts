import { asc, eq } from "drizzle-orm";
import { listSessionAttachments } from "@/lib/council/attachments";
import { getDb, schema } from "@/lib/db";
import type { CouncilEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AgentLike {
  id?: string;
  role?: string;
  model?: string;
  fallbackModels?: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function toMarkdown(
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
      if (d.userQuery) continue;
      if (d.attachmentDigest) line = `**[attachment digest]** ${msg}`;
      else if (d.guidance) line = `**[director guidance]** ${msg}`;
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

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get("format") ?? "md";
  if (format !== "md" && format !== "json") {
    return Response.json({ error: "format must be md or json" }, { status: 400 });
  }
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!session) return Response.json({ error: "quest not found" }, { status: 404 });
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
  const headers = {
    "Content-Disposition": `attachment; filename="council-${id.replace(/[^\w-]/g, "_")}.${format}"`,
    "Cache-Control": "no-store",
  };
  if (format === "json") {
    const agentMessages = db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, id))
      .orderBy(asc(schema.agentMessages.id))
      .all();
    return new Response(JSON.stringify({ session, plan: plan ?? null, attachments, events, agentMessages }, null, 2), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(toMarkdown(session, plan, events, attachments), {
    headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" },
  });
}
