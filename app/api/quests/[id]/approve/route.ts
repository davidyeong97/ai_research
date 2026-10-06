import { eq } from "drizzle-orm";
import { z } from "zod";
import { getControl } from "@/lib/council/control";
import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ approved: z.boolean() });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "approved (boolean) is required" }, { status: 400 });
  const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!session) return Response.json({ error: "quest not found" }, { status: 404 });
  if (session.status !== "awaiting_approval" || !getControl(id)?.decide(body.data.approved)) {
    return Response.json({ error: `quest is not awaiting approval (${session.status})` }, { status: 409 });
  }
  return Response.json({ ok: true, approved: body.data.approved });
}
