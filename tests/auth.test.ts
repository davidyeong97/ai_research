import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { POST as login, resetLoginLimiter } from "@/app/api/login/route";
import { POST as logout } from "@/app/api/logout/route";
import { SESSION_COOKIE, computeSessionToken, isValidSession, timingSafeEqualStr } from "@/lib/auth/session";

const orig = process.env.APP_PASSWORD;
beforeEach(() => {
  process.env.APP_PASSWORD = "hunter2";
  resetLoginLimiter();
});
afterEach(() => {
  if (orig === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = orig;
});

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined);

describe("proxy", () => {
  it("redirects unauthenticated pages to /login", async () => {
    const res = await proxy(req("/"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
  it("returns 401 for API and SSE routes", async () => {
    expect((await proxy(req("/api/quests"))).status).toBe(401);
    expect((await proxy(req("/api/quests/abc/stream"))).status).toBe(401);
  });
  it("allows login routes", async () => {
    expect((await proxy(req("/login"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/api/login"))).headers.get("x-middleware-next")).toBe("1");
  });
  it("allows valid cookie, rejects raw password and bad token", async () => {
    const token = await computeSessionToken("hunter2");
    expect(token).not.toContain("hunter2");
    const ok = await proxy(req("/api/quests", `${SESSION_COOKIE}=${token}`));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/api/quests", `${SESSION_COOKIE}=hunter2`))).status).toBe(401);
    expect((await proxy(req("/api/quests", `${SESSION_COOKIE}=${token}x`))).status).toBe(401);
    const old = "a".repeat(64);
    expect((await proxy(req("/api/quests", `${SESSION_COOKIE}=${old}`))).status).toBe(401);
  });
  it("refuses to serve when APP_PASSWORD is unset", async () => {
    delete process.env.APP_PASSWORD;
    expect((await proxy(req("/"))).status).toBe(503);
    expect((await proxy(req("/login"))).status).toBe(503);
    expect((await proxy(req("/api/quests"))).status).toBe(503);
  });
});

describe("login/logout", () => {
  const post = (password: unknown) =>
    new Request("http://localhost/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  it("sets httpOnly lax cookie on correct password", async () => {
    const res = await login(post("hunter2"));
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    const value = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(sc)![1];
    expect(await isValidSession(value, "hunter2")).toBe(true);
    expect(sc).toMatch(/Max-Age=604800/i);
    expect(sc).not.toMatch(/Secure/i);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=lax/i);
  });
  it("rejects wrong password", async () => {
    const res = await login(post("nope"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("logout clears cookie", async () => {
    const sc = (await logout(new Request("http://localhost/api/logout", { method: "POST" }))).headers.get("set-cookie")!;
    expect(sc).toMatch(/Max-Age=0/i);
  });
});

describe("timingSafeEqualStr", () => {
  it("compares", () => {
    expect(timingSafeEqualStr("a", "a")).toBe(true);
    expect(timingSafeEqualStr("a", "b")).toBe(false);
    expect(timingSafeEqualStr("a", "ab")).toBe(false);
  });
});

describe("session tokens", () => {
  afterEach(() => vi.useRealTimers());
  it("round-trips", async () => {
    expect(await isValidSession(await computeSessionToken("hunter2"), "hunter2")).toBe(true);
    expect(await isValidSession(await computeSessionToken("hunter2"), "other")).toBe(false);
  });
  it("rejects expired tokens", async () => {
    const t = await computeSessionToken("hunter2", 1_000_000);
    expect(await isValidSession(t, "hunter2", 1_000_000 + 1000)).toBe(true);
    expect(await isValidSession(t, "hunter2", 1_000_000 + 168 * 3600_000 + 1)).toBe(false);
  });
  it("rejects tampered, malformed and old static tokens", async () => {
    const [i, e, m] = (await computeSessionToken("hunter2")).split(".");
    expect(await isValidSession(`${i}.${Number(e) + 1000}.${m}`, "hunter2")).toBe(false);
    expect(await isValidSession(`${i}.${e}.${"0".repeat(64)}`, "hunter2")).toBe(false);
    expect(await isValidSession("garbage", "hunter2")).toBe(false);
    expect(await isValidSession(undefined, "hunter2")).toBe(false);
    expect(await isValidSession("f".repeat(64), "hunter2")).toBe(false);
  });
});

describe("rate limiting", () => {
  const attempt = (password: string, ip: string) =>
    login(
      new Request("http://localhost/api/login", {
        method: "POST",
        headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
        body: JSON.stringify({ password }),
      }),
    );
  afterEach(() => vi.useRealTimers());
  it("locks out the 6th failed attempt from the same IP only", async () => {
    for (let i = 0; i < 5; i++) expect((await attempt("bad", "1.1.1.1")).status).toBe(401);
    const res = await attempt("hunter2", "1.1.1.1");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await res.json()).error).toBeTruthy();
    expect((await attempt("hunter2", "2.2.2.2")).status).toBe(200);
  });
  it("success resets the counter", async () => {
    for (let i = 0; i < 4; i++) await attempt("bad", "3.3.3.3");
    expect((await attempt("hunter2", "3.3.3.3")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await attempt("bad", "3.3.3.3")).status).toBe(401);
    expect((await attempt("bad", "3.3.3.3")).status).toBe(429);
  });
  it("expires after the window", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) await attempt("bad", "4.4.4.4");
    expect((await attempt("bad", "4.4.4.4")).status).toBe(429);
    vi.advanceTimersByTime(16 * 60_000);
    expect((await attempt("hunter2", "4.4.4.4")).status).toBe(200);
  });
});

describe("cookie secure flag", () => {
  const cookieFor = async (url: string, headers: Record<string, string> = {}) => {
    const res = await login(
      new Request(url, { method: "POST", headers, body: JSON.stringify({ password: "hunter2" }) }),
    );
    return res.headers.get("set-cookie")!;
  };
  afterEach(() => {
    delete process.env.COOKIE_SECURE;
  });
  it("no Secure over http", async () => {
    expect(await cookieFor("http://localhost/api/login")).not.toMatch(/Secure/i);
  });
  it("Secure over https or x-forwarded-proto", async () => {
    expect(await cookieFor("https://localhost/api/login")).toMatch(/Secure/i);
    expect(await cookieFor("http://localhost/api/login", { "x-forwarded-proto": "https" })).toMatch(/Secure/i);
  });
  it("Secure when COOKIE_SECURE=true", async () => {
    process.env.COOKIE_SECURE = "true";
    expect(await cookieFor("http://localhost/api/login")).toMatch(/Secure/i);
  });
});
