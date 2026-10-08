import { z } from "zod";
import { decideApproval, ServiceError } from "@/lib/council/service";

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
  try {
    return Response.json(decideApproval(id, body.data.approved));
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
