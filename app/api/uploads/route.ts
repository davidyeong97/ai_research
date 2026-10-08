import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  UploadError,
  deleteAttachments,
  maxUploadBytes,
  saveUpload,
} from "@/lib/council/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  if (files.length === 0) return NextResponse.json({ error: "No files provided" }, { status: 400 });
  if (files.length > MAX_ATTACHMENTS) {
    return NextResponse.json({ error: `Too many files (max ${MAX_ATTACHMENTS})` }, { status: 413 });
  }
  if (files.some((f) => f.size > maxUploadBytes())) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "Total upload too large" }, { status: 413 });
  }
  const saved: string[] = [];
  try {
    const out = [];
    for (const f of files) {
      const rec = await saveUpload(f);
      saved.push(rec.id);
      out.push({ id: rec.id, filename: rec.filename, mime: rec.mime, kind: rec.kind, sizeBytes: rec.sizeBytes });
    }
    return NextResponse.json({ attachments: out }, { status: 201 });
  } catch (e) {
    await deleteAttachments(saved);
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
