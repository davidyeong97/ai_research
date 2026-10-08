import { z } from "zod";
import { MAX_ATTACHMENTS, UploadError } from "@/lib/council/attachments";
import { ServiceError, listQuests, startQuest } from "@/lib/council/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  query: z.string().trim().max(4000).optional().default(""),
  attachmentIds: z.array(z.string().min(1).max(100)).max(MAX_ATTACHMENTS).optional(),
  remember: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    const tooMany = body.error.issues.some((i) => i.path[0] === "attachmentIds" && i.code === "too_big");
    return Response.json(
      { error: tooMany ? `Too many attachments (max ${MAX_ATTACHMENTS})` : "query is required" },
      { status: 400 },
    );
  }
  const attachmentIds = body.data.attachmentIds ?? [];
  if (!body.data.query && attachmentIds.length === 0) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }
  try {
    const { questId, plan, attachments } = await startQuest({
      query: body.data.query,
      source: "web",
      attachmentIds,
      remember: body.data.remember,
    });
    return Response.json({ questId, plan, attachments }, { status: 201 });
  } catch (e) {
    if (e instanceof UploadError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof ServiceError) return Response.json({ error: e.message }, { status: e.httpStatus });
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<Response> {
  const raw = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(raw) ? raw : 20;
  return Response.json({ quests: listQuests({ limit }) });
}
