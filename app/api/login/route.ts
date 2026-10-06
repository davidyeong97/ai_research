import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  computeSessionToken,
  cookieOptionsFor,
  passwordMatches,
} from "@/lib/auth/session";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const maxAttempts = () => envInt("LOGIN_MAX_ATTEMPTS", 5);
const windowMs = () => envInt("LOGIN_WINDOW_MINUTES", 15) * 60_000;

type Entry = { count: number; first: number };
const g = globalThis as unknown as { __councilLoginAttempts?: Map<string, Entry> };
const attempts = (g.__councilLoginAttempts ??= new Map<string, Entry>());

/** Test-only: clear the in-memory limiter. */
export function resetLoginLimiter(): void {
  attempts.clear();
}

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function prune(now: number) {
  const w = windowMs();
  for (const [k, e] of attempts) if (now - e.first >= w) attempts.delete(k);
}

export async function POST(request: Request) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "APP_PASSWORD is not configured" }, { status: 503 });
  }
  const now = Date.now();
  prune(now);
  const ip = clientIp(request);
  const entry = attempts.get(ip);
  if (entry && entry.count >= maxAttempts()) {
    const retry = Math.max(1, Math.ceil((entry.first + windowMs() - now) / 1000));
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retry) } },
    );
  }
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!(await passwordMatches(password, expected))) {
    if (entry) entry.count++;
    else attempts.set(ip, { count: 1, first: now });
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await computeSessionToken(expected), cookieOptionsFor(request));
  return res;
}
