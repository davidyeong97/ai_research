export const SESSION_COOKIE = "council_session";
const SESSION_LABEL = "council-session-v1";
const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of a fixed string keyed by the password; never the raw password. */
export async function computeSessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(SESSION_LABEL)));
}

/** Constant-time string comparison (length is not secret for fixed-size digests). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Compares passwords by comparing their HMAC digests, so lengths do not leak. */
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([computeSessionToken(input), computeSessionToken(expected)]);
  return timingSafeEqualStr(a, b);
}

export async function isValidSession(
  cookieValue: string | undefined,
  password: string,
): Promise<boolean> {
  if (!cookieValue) return false;
  return timingSafeEqualStr(cookieValue, await computeSessionToken(password));
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};
