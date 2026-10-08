/** Client-side mirror of the server upload limits (lib/council/attachments.ts). */
export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export const ACCEPT =
  "image/*,application/pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.py,.java,.go,.rs,.c,.cpp,.html,.css,.yaml,.yml,.xml,.sql,.sh";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXTS = new Set(
  "txt md csv json ts tsx js py java go rs c cpp html css yaml yml xml sql sh".split(" "),
);

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

export type ClientKind = "image" | "pdf" | "text";

export function classifyFile(file: { name: string; type: string }): ClientKind | null {
  if (IMAGE_MIMES.has(file.type)) return "image";
  if (file.type === "application/pdf" || extOf(file.name) === "pdf") return "pdf";
  if (TEXT_EXTS.has(extOf(file.name))) return "text";
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Validate `incoming` files against the already selected ones.
 * Returns the accepted files and human-readable errors for the rejected ones.
 */
export function validateFiles(
  existing: File[],
  incoming: File[],
): { accepted: File[]; errors: string[] } {
  const accepted: File[] = [];
  const errors: string[] = [];
  let total = existing.reduce((n, f) => n + f.size, 0);
  for (const f of incoming) {
    if (!classifyFile(f)) {
      errors.push(`${f.name}: unsupported file type`);
    } else if (f.size === 0) {
      errors.push(`${f.name}: file is empty`);
    } else if (f.size > MAX_FILE_BYTES) {
      errors.push(`${f.name}: too large (max ${formatSize(MAX_FILE_BYTES)} per file)`);
    } else if (existing.length + accepted.length >= MAX_ATTACHMENTS) {
      errors.push(`${f.name}: too many files (max ${MAX_ATTACHMENTS})`);
    } else if (total + f.size > MAX_TOTAL_BYTES) {
      errors.push(`${f.name}: total size exceeds ${formatSize(MAX_TOTAL_BYTES)}`);
    } else {
      accepted.push(f);
      total += f.size;
    }
  }
  return { accepted, errors };
}
