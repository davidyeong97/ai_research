import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { UploadError, attachmentFilePath, getAttachment } from "@/lib/council/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rec = getAttachment(id);
  if (!rec) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let file: string;
  try {
    file = attachmentFilePath(rec);
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }
  if (!fs.existsSync(file)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ascii = rec.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = rec.kind === "image" ? "inline" : "attachment";
  const mime = rec.kind === "text" ? "text/plain; charset=utf-8" : rec.mime;
  const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(rec.sizeBytes),
      "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(rec.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
