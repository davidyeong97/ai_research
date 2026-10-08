import { z } from "zod";
import { ServiceError, listQuests, startQuest } from "@/lib/council/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ query: z.string().trim().min(1).max(4000) });

export async function POST(req: Request): Promise<Response> {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "query is required" }, { status: 400 });
  try {
    const { questId, plan } = await startQuest({ query: body.data.query, source: "web" });
    return Response.json({ questId, plan }, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.httpStatus });
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<Response> {
  const raw = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(raw) ? raw : 20;
  return Response.json({ quests: listQuests({ limit }) });
}
