import type { LLMClient } from "../llm";
import { getLLMClient } from "../quests";
import { memoryEmbedModel } from "./config";

const BATCH_SIZE = 64;

export interface EmbedOptions {
  llm?: LLMClient;
  model?: string;
}

/**
 * Embeds texts via the LLMClient (OpenRouter embeddings endpoint). Batched, one
 * retry per batch. On failure resolves to `null` entries (callers degrade to
 * FTS-only); never throws.
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Array<Float32Array | null>> {
  const out: Array<Float32Array | null> = texts.map(() => null);
  if (texts.length === 0) return out;
  let llm: LLMClient;
  try {
    llm = opts.llm ?? getLLMClient();
  } catch {
    return out;
  }
  const model = opts.model ?? memoryEmbedModel();
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.embed({ texts: batch, model });
        if (res.vectors.length !== batch.length) throw new Error("embedding count mismatch");
        res.vectors.forEach((v, i) => {
          out[start + i] = toUnit(v);
        });
        break;
      } catch (err) {
        if (attempt === 1) console.warn("[memory] embedding failed, using FTS only:", String(err));
      }
    }
  }
  return out;
}

export async function embedText(
  text: string,
  opts: EmbedOptions = {},
): Promise<Float32Array | null> {
  return (await embedTexts([text], opts))[0];
}

/** Normalises to unit length (so cosine = dot); null for empty/zero/non-finite vectors. */
function toUnit(v: number[]): Float32Array | null {
  if (v.length === 0) return null;
  let norm = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return null;
    norm += x * x;
  }
  if (norm === 0) return null;
  norm = Math.sqrt(norm);
  const f = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) f[i] = v[i] / norm;
  return f;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVector(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
