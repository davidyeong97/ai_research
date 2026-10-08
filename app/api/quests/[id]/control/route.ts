import { z } from "zod";
import { MAX_GUIDANCE_CHARS } from "@/lib/council/control";
import { controlQuest, ServiceError } from "@/lib/council/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("inject"), text: z.string().trim().min(1).max(MAX_GUIDANCE_CHARS) }),
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json(
      { error: "invalid body: {action: pause|resume|inject|cancel, text?}" },
      { status: 400 },
    );
  }
  const a = body.data;
  try {
    return Response.json(controlQuest(id, a.action, a.action === "inject" ? a.text : undefined));
  } catch (e) {
    if (e instanceof ServiceError) {
      return Response.json(
        { error: e.message, ...(e.reason ? { reason: e.reason } : {}) },
        { status: e.httpStatus },
      );
    }
    throw e;
  }
}
