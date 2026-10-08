import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getDb, schema } from "@/lib/db";
import { POST } from "@/app/api/uploads/route";
import { GET } from "@/app/api/uploads/[id]/route";
import {
  getAttachment,
  linkToSession,
  purgeStaleUploads,
  readAttachmentBytes,
  readAttachmentText,
  sanitizeFilename,
  saveUpload,
} from "@/lib/council/attachments";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  process.env.UPLOADS_DIR = dir;
  process.env.DATABASE_PATH = ":memory:";
  (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
});
afterEach(() => {
  delete process.env.UPLOADS_DIR;
  delete process.env.MAX_UPLOAD_MB;
  delete process.env.DATABASE_PATH;
  (globalThis as unknown as { __councilDb?: unknown }).__councilDb = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (files: File[]) => {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  return POST(new NextRequest("http://localhost/api/uploads", { method: "POST", body: fd }));
};
const f = (data: BlobPart, name: string, type = "") => new File([data], name, { type });

describe("uploads", () => {
  it("accepts image, pdf and text", async () => {
    const res = await upload([f(PNG, "a.png", "image/png"), f(PDF, "b.pdf"), f("# hi", "c.md")]);
    expect(res.status).toBe(201);
    const { attachments } = await res.json();
    expect(attachments.map((a: { kind: string }) => a.kind)).toEqual(["image", "pdf", "text"]);
    expect(readAttachmentBytes(attachments[0].id)).toEqual(PNG);
    expect(readAttachmentText(attachments[2].id, 3)).toBe("# h");
    expect(fs.readdirSync(dir)).toHaveLength(3);
  });

  it("rejects spoofed MIME, bad text and unknown types with 415", async () => {
    expect((await upload([f("<html>x</html>", "evil.png", "image/png")])).status).toBe(415);
    expect((await upload([f("hello", "a.exe", "text/plain")])).status).toBe(415);
    expect((await upload([f(new Uint8Array([0xff, 0xfe, 0xfa]), "a.txt")])).status).toBe(415);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("400 without files, 413 for oversize and too many", async () => {
    expect((await upload([])).status).toBe(400);
    process.env.MAX_UPLOAD_MB = "0.001";
    expect((await upload([f(new Uint8Array(2000).fill(65), "big.txt")])).status).toBe(413);
    delete process.env.MAX_UPLOAD_MB;
    const six = Array.from({ length: 6 }, (_, i) => f("x", `${i}.txt`));
    expect((await upload(six)).status).toBe(413);
  });

  it("sanitizes path traversal filenames", async () => {
    expect(sanitizeFilename("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFilename("..\\..\\win\\a b.png")).toBe("a b.png");
    expect(sanitizeFilename("")).toBe("file");
    const rec = await saveUpload(f(PNG, "../../x.png"));
    expect(rec.filename).toBe("x.png");
    expect(fs.existsSync(path.join(dir, rec.storagePath))).toBe(true);
  });

  it("serves with safe headers", async () => {
    const img = await saveUpload(f(PNG, "a.png"));
    const txt = await saveUpload(f("<script>1</script>", "a.html"));
    const call = (id: string) =>
      GET(new NextRequest(`http://localhost/api/uploads/${id}`), { params: Promise.resolve({ id }) });
    const r1 = await call(img.id);
    expect(r1.headers.get("content-type")).toBe("image/png");
    expect(r1.headers.get("content-disposition")).toMatch(/^inline/);
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r1.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(PNG);
    const r2 = await call(txt.id);
    expect(r2.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(r2.headers.get("content-type")).toContain("text/plain");
    expect((await call("nope")).status).toBe(404);
  });

  it("links to sessions once and purges stale unlinked uploads", async () => {
    const db = getDb();
    db.insert(schema.sessions).values([
      { id: "s1", query: "q", createdAt: 1 },
      { id: "s2", query: "q", createdAt: 1 },
    ]).run();
    const a = await saveUpload(f(PNG, "a.png"));
    const b = await saveUpload(f(PNG, "b.png"));
    linkToSession([a.id], "s1");
    expect(() => linkToSession([a.id], "s2")).toThrow();
    expect(() => linkToSession(["missing"], "s2")).toThrow();
    const purged = await purgeStaleUploads(db, Date.now() + 25 * 3_600_000);
    expect(purged).toBe(1);
    expect(getAttachment(a.id)).toBeDefined();
    expect(getAttachment(b.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, b.storagePath))).toBe(false);
    expect(await purgeStaleUploads(db, Date.now())).toBe(0);
  });
});
