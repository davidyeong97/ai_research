import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { defaultDbPath, getDb, schema, type DB } from "../db";

export type AttachmentKind = "image" | "pdf" | "text";
export type AttachmentRecord = typeof schema.attachments.$inferSelect;

export const MAX_ATTACHMENTS = 5;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const STALE_UPLOAD_MS = 24 * 3_600_000;

export const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "ts",
  "tsx",
  "js",
  "py",
  "java",
  "go",
  "rs",
  "c",
  "cpp",
  "html",
  "css",
  "yaml",
  "yml",
  "xml",
  "sql",
  "sh",
]);

export class UploadError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export function maxUploadBytes(): number {
  const n = Number(process.env.MAX_UPLOAD_MB);
  return (Number.isFinite(n) && n > 0 ? n : 10) * 1024 * 1024;
}

export function uploadsDir(): string {
  if (process.env.UPLOADS_DIR) return path.resolve(process.env.UPLOADS_DIR);
  return path.join(path.dirname(path.resolve(defaultDbPath())), "uploads");
}

/** Strip any path components and unsafe characters from a client-supplied filename. */
export function sanitizeFilename(name: string): string {
  let base =
    String(name ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  base = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/[^\p{L}\p{N}._() -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (base.length > 100) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 100 - ext.length) + ext;
  }
  return base || "file";
}

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((v, i) => b[offset + i] === v);
}

function detectBinary(b: Uint8Array): { mime: string; kind: AttachmentKind } | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: "image/png", kind: "image" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" };
  if (
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return { mime: "image/gif", kind: "image" };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8))
    return { mime: "image/webp", kind: "image" };
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return { mime: "application/pdf", kind: "pdf" };
  return null;
}

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Validate and persist an uploaded file. Throws UploadError (413/415). */
export async function saveUpload(file: File, db: DB = getDb()): Promise<AttachmentRecord> {
  if (file.size > maxUploadBytes())
    throw new UploadError(413, `File too large: ${sanitizeFilename(file.name)}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxUploadBytes())
    throw new UploadError(413, `File too large: ${sanitizeFilename(file.name)}`);
  if (bytes.byteLength === 0) throw new UploadError(400, "Empty file");
  const filename = sanitizeFilename(file.name);
  const ext = path.extname(filename).slice(1).toLowerCase();

  let detected = detectBinary(bytes);
  if (!detected) {
    if (!TEXT_EXTENSIONS.has(ext) || !isUtf8Text(bytes)) {
      throw new UploadError(415, `Unsupported file type: ${filename}`);
    }
    detected = { mime: "text/plain", kind: "text" };
  }

  const id = randomUUID();
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, id), bytes, { mode: 0o600 });
  const record: AttachmentRecord = {
    id,
    sessionId: null,
    filename,
    mime: detected.mime,
    kind: detected.kind,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storagePath: id,
    createdAt: Date.now(),
  };
  try {
    db.insert(schema.attachments).values(record).run();
  } catch (e) {
    await fs.promises.rm(path.join(dir, id), { force: true });
    throw e;
  }
  return record;
}

export function getAttachment(id: string, db: DB = getDb()): AttachmentRecord | undefined {
  return db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get();
}

/** Absolute path of the stored file; guarded against escaping the uploads dir. */
export function attachmentFilePath(rec: AttachmentRecord): string {
  const dir = uploadsDir();
  const p = path.resolve(dir, rec.storagePath);
  if (path.dirname(p) !== dir) throw new UploadError(404, "Attachment not found");
  return p;
}

export function readAttachmentBytes(id: string, db: DB = getDb()): Uint8Array {
  const rec = getAttachment(id, db);
  if (!rec) throw new UploadError(404, "Attachment not found");
  return new Uint8Array(fs.readFileSync(attachmentFilePath(rec)));
}

/** UNTRUSTED text content; callers must pass it through sanitizeText / wrap helpers. */
export function readAttachmentText(id: string, maxChars: number, db: DB = getDb()): string {
  const rec = getAttachment(id, db);
  if (!rec) throw new UploadError(404, "Attachment not found");
  if (rec.kind !== "text") throw new UploadError(415, "Attachment is not a text file");
  const s = new TextDecoder("utf-8").decode(fs.readFileSync(attachmentFilePath(rec)));
  return s.length > maxChars ? s.slice(0, Math.max(0, maxChars)) : s;
}

/** Link unused uploads to a session; rejects unknown ids and ids linked to another session. */
export function linkToSession(ids: string[], sessionId: string, db: DB = getDb()): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.id, unique))
      .all();
    if (rows.length !== unique.length) throw new UploadError(404, "Unknown attachment id");
    if (rows.some((r) => r.sessionId && r.sessionId !== sessionId)) {
      throw new UploadError(409, "Attachment already used by another quest");
    }
    tx.update(schema.attachments)
      .set({ sessionId })
      .where(inArray(schema.attachments.id, unique))
      .run();
  });
}

export function listSessionAttachments(sessionId: string, db: DB = getDb()): AttachmentRecord[] {
  return db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.sessionId, sessionId))
    .all();
}

export async function deleteAttachments(ids: string[], db: DB = getDb()): Promise<void> {
  for (const id of ids) {
    const rec = getAttachment(id, db);
    if (!rec) continue;
    db.delete(schema.attachments).where(eq(schema.attachments.id, id)).run();
    try {
      await fs.promises.rm(attachmentFilePath(rec), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Delete unlinked uploads older than 24h. Returns number purged. */
export async function purgeStaleUploads(
  db: DB = getDb(),
  now: number = Date.now(),
): Promise<number> {
  const stale = db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(
      and(
        isNull(schema.attachments.sessionId),
        lt(schema.attachments.createdAt, now - STALE_UPLOAD_MS),
      ),
    )
    .all();
  await deleteAttachments(
    stale.map((r) => r.id),
    db,
  );
  return stale.length;
}

/** Resolve attachment ids for a new quest: max 5, all must exist and be unlinked. */
export function resolveUnlinkedAttachments(ids: string[], db: DB = getDb()): AttachmentRecord[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ATTACHMENTS) {
    throw new UploadError(400, `Too many attachments (max ${MAX_ATTACHMENTS})`);
  }
  if (unique.length === 0) return [];
  const rows = db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.id, unique))
    .all();
  if (rows.length !== unique.length) throw new UploadError(404, "Unknown attachment id");
  if (rows.some((r) => r.sessionId))
    throw new UploadError(409, "Attachment already used by another quest");
  return unique.map((id) => rows.find((r) => r.id === id)!);
}
