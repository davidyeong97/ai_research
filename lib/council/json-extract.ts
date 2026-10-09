/**
 * Robust extraction of JSON values from free-form LLM output: tolerates code
 * fences, prose before/after, echoed braces, trailing commas and single-quoted keys.
 */

/** Removes markdown code-fence markers, keeping their content. */
export function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, "");
}

/** Finds balanced top-level candidates opened by `open`, respecting JSON strings and escapes. */
export function balancedCandidates(text: string, open: "{" | "[" = "{"): string[] {
  const close = open === "{" ? "}" : "]";
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== open) continue;
    let depth = 0;
    let inStr: string | null = null;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end >= 0) out.push(text.slice(i, end + 1));
  }
  return out;
}

/** Lenient repairs: trailing commas, single-quoted keys/values, unquoted keys. */
function repair(s: string): string {
  return s
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)'([^'\\\n]*)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^'\\\n]*)'/g, ': "$1"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(repair(s));
    } catch {
      return undefined;
    }
  }
}

/**
 * Returns every parseable JSON object/array candidate found in the text, in order
 * (outermost first at each position). Nested candidates are included.
 */
export function extractJsonCandidates(text: string, open: "{" | "[" = "{"): unknown[] {
  const src = stripCodeFences(text);
  const out: unknown[] = [];
  for (const c of balancedCandidates(src, open)) {
    const v = tryParse(c);
    if (v !== undefined && v !== null && typeof v === "object") out.push(v);
  }
  return out;
}

/** Returns the first candidate accepted by `validate` (e.g. a zod safeParse wrapper). */
export function extractJson<T>(
  text: string,
  validate: (v: unknown) => T | undefined,
  open: "{" | "[" = "{",
): T | undefined {
  for (const v of extractJsonCandidates(text, open)) {
    const r = validate(v);
    if (r !== undefined) return r;
  }
  return undefined;
}
