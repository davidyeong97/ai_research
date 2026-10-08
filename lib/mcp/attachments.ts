import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  UploadError,
  deleteAttachments,
  maxUploadBytes,
  saveUpload,
} from "../council/attachments";
import { getDb, type DB } from "../db";
import { ServiceError } from "../council/service";

export interface McpAttachmentInput {
  filename: string;
  mimeType?: string;
  dataBase64: string;
}

/** Upper bound for a base64 string that decodes to at most maxUploadBytes() (zod max length). */
export function maxBase64Chars(): number {
  return Math.ceil(maxUploadBytes() / 3) * 4 + 4;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(data: string, name: string): Buffer {
  const clean = data.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (!clean || clean.length % 4 === 1 || !B64.test(clean)) {
    throw new ServiceError("invalid", `Attachment "${name}" is not valid base64`);
  }
  return Buffer.from(clean, "base64");
}

/**
 * Decodes base64 attachments and persists them via saveUpload (same type
 * validation and limits as POST /api/uploads). All-or-nothing: on any failure
 * already-saved files are removed and a ServiceError("invalid") is thrown.
 */
export async function saveMcpAttachments(
  inputs: McpAttachmentInput[] | undefined,
  db: DB = getDb(),
): Promise<string[]> {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new ServiceError("invalid", `Too many attachments (max ${MAX_ATTACHMENTS})`);
  }
  const limit = maxUploadBytes();
  let total = 0;
  const decoded: { name: string; bytes: Buffer; mime: string }[] = [];
  for (const a of inputs) {
    const name = a.filename;
    // Reject before decoding when the encoded length already exceeds the cap.
    if (a.dataBase64.length > maxBase64Chars()) {
      throw new ServiceError("invalid", `Attachment "${name}" is too large (max ${Math.floor(limit / 1048576)} MB)`);
    }
    const bytes = decodeBase64(a.dataBase64, name);
    if (bytes.byteLength > limit) {
      throw new ServiceError("invalid", `Attachment "${name}" is too large (max ${Math.floor(limit / 1048576)} MB)`);
    }
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new ServiceError("invalid", "Total attachment size too large");
    decoded.push({ name, bytes, mime: a.mimeType || "application/octet-stream" });
  }
  const saved: string[] = [];
  try {
    for (const d of decoded) {
      const rec = await saveUpload(new File([new Uint8Array(d.bytes)], d.name, { type: d.mime }), db);
      saved.push(rec.id);
    }
    return saved;
  } catch (e) {
    await deleteAttachments(saved, db);
    if (e instanceof UploadError) throw new ServiceError("invalid", e.message);
    throw e;
  }
}

export { deleteAttachments };
