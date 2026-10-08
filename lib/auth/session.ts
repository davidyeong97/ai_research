export const SESSION_COOKIE = "council_session";
const SESSION_LABEL = "council-session-v2";
const PASSWORD_LABEL = "council-session-v1";
const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function sessionTtlSeconds(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 168) * 3600;
}

/** Token: `<issuedAtMs>.<expiresAtMs>.<hexHmac>`; HMAC keyed by the password, never the raw password. */
export async function computeSessionToken(
  password: string,
  now: number = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now);
  const expiresAt = issuedAt + sessionTtlSeconds() * 1000;
  const mac = await hmacHex(password, `${SESSION_LABEL}|${issuedAt}|${expiresAt}`);
  return `${issuedAt}.${expiresAt}.${mac}`;
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
  const [a, b] = await Promise.all([
    hmacHex(input, PASSWORD_LABEL),
    hmacHex(expected, PASSWORD_LABEL),
  ]);
  return timingSafeEqualStr(a, b);
}

export async function isValidSession(
  cookieValue: string | undefined,
  password: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!cookieValue) return false;
  const m = /^(\d{1,16})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(cookieValue);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  const expiresAt = Number(m[2]);
  const expected = await hmacHex(password, `${SESSION_LABEL}|${m[1]}|${m[2]}`);
  if (!timingSafeEqualStr(m[3], expected)) return false;
  return issuedAt <= now + 60_000 && now < expiresAt;
}

function isHttps(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch {
    // ignore
  }
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

/** `secure` only for HTTPS requests or COOKIE_SECURE=true; never unconditional (plain-http LAN/VPN use). */
export function cookieOptionsFor(request: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: sessionTtlSeconds(),
    ...(isHttps(request) || process.env.COOKIE_SECURE === "true" ? { secure: true } : {}),
  };
}
