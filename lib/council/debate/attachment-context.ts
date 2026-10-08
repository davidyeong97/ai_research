import { getDb, type DB } from "../../db";
import { readAttachmentBytes, readAttachmentText, type AttachmentRecord } from "../attachments";
import type { ContentPart } from "../llm";
import { wrapDataBlock } from "./sanitize";

export const DEFAULT_ATTACHMENT_TEXT_MAX_CHARS = 20000;
export const MANIFEST_PREVIEW_CHARS = 1000;

export function attachmentTextMaxChars(): number {
  const n = Number(process.env.ATTACHMENT_TEXT_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ATTACHMENT_TEXT_MAX_CHARS;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  kind: "image" | "pdf" | "text";
  sizeBytes?: number;
}

export interface MediaPart {
  kind: "image" | "pdf";
  part: ContentPart;
}

/** Everything the orchestrator and debate engine need to know about a quest's attachments. */
export interface AttachmentContext {
  items: AttachmentMeta[];
  /** Sanitized, delimited (untrusted) inline text-file contents; "" when none. */
  textBlock: string;
  /** Short manifest for the orchestrator classification prompt. */
  manifest: string;
  media: MediaPart[];
  hasImages: boolean;
  hasPdf: boolean;
}

export function toMeta(
  r: Pick<AttachmentRecord, "id" | "filename" | "kind" | "sizeBytes">,
): AttachmentMeta {
  return {
    id: r.id,
    filename: r.filename,
    kind: r.kind as AttachmentMeta["kind"],
    sizeBytes: r.sizeBytes,
  };
}

function fmtSize(n: number): string {
  return n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
}

/** Loads bytes/text for the given records. Text content is sanitized and wrapped as untrusted data. */
export function buildAttachmentContext(
  records: AttachmentRecord[],
  db: DB = getDb(),
): AttachmentContext {
  const items = records.map(toMeta);
  const media: MediaPart[] = [];
  const textBlocks: string[] = [];
  const manifest: string[] = [];
  let remaining = attachmentTextMaxChars();
  for (const r of records) {
    manifest.push(
      `- ${wrapDataBlock("attachment_name", {}, r.filename, { maxChars: 120 })} (${r.kind}, ${fmtSize(r.sizeBytes)})`,
    );
    if (r.kind === "image") {
      media.push({
        kind: "image",
        part: { type: "image", data: readAttachmentBytes(r.id, db), mediaType: r.mime },
      });
    } else if (r.kind === "pdf") {
      media.push({
        kind: "pdf",
        part: {
          type: "file",
          data: readAttachmentBytes(r.id, db),
          mediaType: "application/pdf",
          filename: r.filename,
        },
      });
    } else {
      const text = readAttachmentText(r.id, remaining, db);
      manifest.push(
        wrapDataBlock("attachment_file", { name: r.filename }, text, {
          maxChars: MANIFEST_PREVIEW_CHARS,
        }),
      );
      if (remaining > 0) {
        textBlocks.push(
          wrapDataBlock("attachment_file", { name: r.filename, kind: "text" }, text, {
            maxChars: remaining,
          }),
        );
        remaining -= text.length;
      }
    }
  }
  return {
    items,
    textBlock: textBlocks.join("\n\n"),
    manifest: manifest.join("\n"),
    media,
    hasImages: media.some((m) => m.kind === "image"),
    hasPdf: media.some((m) => m.kind === "pdf"),
  };
}
