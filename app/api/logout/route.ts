import { NextResponse } from "next/server";
import { SESSION_COOKIE, cookieOptionsFor } from "@/lib/auth/session";

export async function POST(request: Request) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptionsFor(request), maxAge: 0 });
  return res;
}
