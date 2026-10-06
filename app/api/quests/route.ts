import { z } from "zod";
import { createQuest } from "@/lib/council/quests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ query: z.string().trim().min(1).max(4000) });

export async function POST(req: Request): Promise<Response> {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "query is required" }, { status: 400 });
  try {
    const { questId, plan } = await createQuest(body.data.query);
    return Response.json({ questId, plan }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
