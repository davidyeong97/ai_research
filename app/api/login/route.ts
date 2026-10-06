import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  computeSessionToken,
  cookieOptions,
  passwordMatches,
} from "@/lib/auth/session";

export async function POST(request: Request) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: "APP_PASSWORD is not configured" }, { status: 503 });
  }
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!(await passwordMatches(password, expected))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await computeSessionToken(expected), cookieOptions);
  return res;
}
