import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession } from "@/lib/auth/session";
import { bearerMatches, checkMcpRateLimit, isMcpPath, mcpTokenFromEnv, parseBearer } from "@/lib/auth/mcp";

const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Machine endpoint: bearer token only. Cookie sessions never grant access here.
  if (isMcpPath(pathname)) {
    const expected = mcpTokenFromEnv();
    if (!expected) return NextResponse.json({ error: "MCP disabled" }, { status: 503 });
    const presented = parseBearer(request.headers.get("authorization"));
    if (!(await bearerMatches(presented, expected))) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    const retryAfter = checkMcpRateLimit(expected);
    if (retryAfter) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
    return NextResponse.next();
  }

  const isApi = pathname.startsWith("/api/");
  const password = process.env.APP_PASSWORD;

  if (!password) {
    const msg =
      "APP_PASSWORD is not set. Refusing to serve. Set APP_PASSWORD in the environment and restart.";
    if (isApi) return NextResponse.json({ error: msg }, { status: 503 });
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Server misconfigured</title><body style="font-family:sans-serif;padding:2rem"><h1>Server misconfigured</h1><p>${msg}</p></body>`,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value, password)) {
    return NextResponse.next();
  }

  if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
