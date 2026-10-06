import { eq } from "drizzle-orm";
import { z } from "zod";
import { getControl, MAX_GUIDANCE_CHARS } from "@/lib/council/control";
import { getDb, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("inject"), text: z.string().trim().min(1).max(MAX_GUIDANCE_CHARS) }),
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid body: {action: pause|resume|inject, text?}" }, { status: 400 });
  }
  const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!session) return Response.json({ error: "quest not found" }, { status: 404 });
  const control = getControl(id);
  if (session.status !== "running" || !control) {
    return Response.json({ error: `quest is not running (${session.status})` }, { status: 409 });
  }
  const a = body.data;
  if (a.action === "pause") control.pause();
  else if (a.action === "resume") control.resume();
  else control.inject(a.text);
  return Response.json({ ok: true, paused: control.paused });
}
