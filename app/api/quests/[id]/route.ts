import { ServiceError, getQuestSnapshot } from "@/lib/council/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight quest metadata (no event replay payload) for deep links. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const s = getQuestSnapshot(id, { sinceSeq: Number.MAX_SAFE_INTEGER });
    return Response.json({
      questId: s.questId,
      query: s.query,
      status: s.status,
      source: s.source,
      totalCostUsd: s.totalCostUsd,
    });
  } catch (e) {
    if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.httpStatus });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
