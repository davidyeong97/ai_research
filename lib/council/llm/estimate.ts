import type { ChatMessage, ContentPart } from "./types";

export const TOKENS_PER_IMAGE = 1500;
const TOKENS_PER_PDF_PAGE = 1000;
/** Conservative bytes-per-page guess for PDFs (~50 KB/page). */
const BYTES_PER_PDF_PAGE = 50_000;
const MAX_PDF_PAGES = 100;

function byteLength(data: Uint8Array | string): number {
  return typeof data === "string" ? Math.floor((data.length * 3) / 4) : data.byteLength;
}

export function estimatePartTokens(part: ContentPart): number {
  if (part.type === "text") return Math.ceil(part.text.length / 4);
  if (part.type === "image") return TOKENS_PER_IMAGE;
  const pages = Math.min(
    MAX_PDF_PAGES,
    Math.max(1, Math.ceil(byteLength(part.data) / BYTES_PER_PDF_PAGE)),
  );
  return pages * TOKENS_PER_PDF_PAGE;
}

/** Conservative prompt-token estimate: text/4 plus fixed per-image and per-PDF-page costs. */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += Math.ceil(m.content.length / 4);
    else for (const p of m.content) total += estimatePartTokens(p);
  }
  return total;
}

