import { getDb } from "@/lib/db";
import { buildExport } from "@/lib/council/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get("format") ?? "md";
  if (format !== "md" && format !== "json") {
    return Response.json({ error: "format must be md or json" }, { status: 400 });
  }
  const body = buildExport(getDb(), id, format);
  if (body === undefined) return Response.json({ error: "quest not found" }, { status: 404 });
  const headers = {
    "Content-Disposition": `attachment; filename="council-${id.replace(/[^\w-]/g, "_")}.${format}"`,
    "Cache-Control": "no-store",
  };
  return new Response(body, {
    headers: {
      ...headers,
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    },
  });
}
