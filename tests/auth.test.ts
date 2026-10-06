import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { POST as login } from "@/app/api/login/route";
import { POST as logout } from "@/app/api/logout/route";
import { SESSION_COOKIE, computeSessionToken, timingSafeEqualStr } from "@/lib/auth/session";

const orig = process.env.APP_PASSWORD;
beforeEach(() => {
  process.env.APP_PASSWORD = "hunter2";
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
    expect(sc).toContain(`${SESSION_COOKIE}=${await computeSessionToken("hunter2")}`);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=lax/i);
  });
  it("rejects wrong password", async () => {
    const res = await login(post("nope"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("logout clears cookie", async () => {
    const sc = (await logout()).headers.get("set-cookie")!;
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
