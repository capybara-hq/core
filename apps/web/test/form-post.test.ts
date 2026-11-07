import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxy from "../src/proxy";

// Acceptance (security): opened over a LAN address the client JS did not load and the sign-in form
// fell back to a native GET, putting the password in the URL. Every form posts now, and the proxy
// answers a native POST itself (lib/form-post.ts).

const KERNEL = "http://localhost:8080";
const WEB = "http://web.example";

const SESSION_COOKIES = [
  "cap_at=at1; Max-Age=900; Path=/; HttpOnly; SameSite=Lax",
  "cap_rt=rt1; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
];

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[];
let login: () => Response;
let setup: () => Response;

const ok = (status = 200) => {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of SESSION_COOKIES) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ account: { id: "a1" } }), { status, headers });
};
const kernelError = (status: number, code: string) =>
  Response.json({ error: { code, message: "x" } }, { status });

beforeEach(() => {
  calls = [];
  login = () => ok();
  setup = () => ok(201);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === `${KERNEL}/api/v1/auth/login`) return login();
      if (url === `${KERNEL}/api/v1/setup` && init?.method === "POST") return setup();
      if (url === `${KERNEL}/api/v1/setup`) return Response.json({ needsSetup: false });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A browser's native form POST from a page of this site. */
const formPost = (path: string, fields: Record<string, string>, headers: HeadersInit = {}) =>
  proxy(
    new NextRequest(`${WEB}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: WEB,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );

const kernelCalls = (path: string) => calls.filter((c) => c.url === `${KERNEL}${path}`);

describe("native sign-in POST", () => {
  it("signs in server side: the kernel gets the credentials as JSON, the browser the cookies and a 303 to returnTo", async () => {
    const res = await formPost("/login?returnTo=%2Fagents%3Ftab%3Dtemplates", {
      login: "grant",
      password: "right-password",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/agents\?tab=templates$/);
    expect(res.headers.getSetCookie()).toEqual(SESSION_COOKIES);
    const [call] = kernelCalls("/api/v1/auth/login");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      login: "grant",
      password: "right-password",
    });
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
  });

  it.each([["//evil.example/x"], ["https://evil.example/"], ["/\\evil.example"], ["/login"]])(
    "an unsafe or looping returnTo (%s) goes home instead",
    async (returnTo) => {
      const res = await formPost(`/login?returnTo=${encodeURIComponent(returnTo)}`, {
        login: "grant",
        password: "right-password",
      });
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location") ?? "", WEB).toString()).toBe(`${WEB}/`);
    },
  );

  it("a wrong password: back to the sign-in page with the error, no cookies, no credentials in the URL", async () => {
    login = () => kernelError(401, "auth.invalid_credentials");
    const res = await formPost("/login?returnTo=%2Fagents", { login: "grant", password: "wrong" });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location, WEB);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("auth.invalid_credentials");
    expect(url.searchParams.get("returnTo")).toBe("/agents");
    expect(location).not.toMatch(/password|wrong|grant/);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an unexpected kernel failure reads unknown", async () => {
    login = () => kernelError(500, "internal");
    const res = await formPost("/login", { login: "grant", password: "x" });
    expect(new URL(res.headers.get("location") ?? "", WEB).searchParams.get("error")).toBe(
      "unknown",
    );
  });

  it("a cross-site POST never reaches the kernel (login CSRF)", async () => {
    const crossSite = await formPost(
      "/login",
      { login: "attacker", password: "x" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(303);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
    expect(kernelCalls("/api/v1/auth/login")).toEqual([]);
  });

  it("without Sec-Fetch-Site, the Origin must be this host", async () => {
    const foreign = await proxy(
      new NextRequest(`${WEB}/login`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: "login=a&password=b",
      }),
    );
    expect(foreign.status).toBe(303);
    expect(kernelCalls("/api/v1/auth/login")).toEqual([]);
    const same = await proxy(
      new NextRequest(`${WEB}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB },
        body: "login=a&password=b",
      }),
    );
    expect(same.headers.getSetCookie()).toEqual(SESSION_COOKIES);
  });
});

describe("credentials in a page URL", () => {
  it("a GET of /login with the form fields in the query does not sign in and drops them", async () => {
    const res = await proxy(
      new NextRequest(`${WEB}/login?login=grant&password=s3cret&returnTo=%2Fagents`),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location, WEB).pathname).toBe("/login");
    expect(new URL(location, WEB).searchParams.get("returnTo")).toBe("/agents");
    expect(location).not.toMatch(/password|s3cret|grant/);
    expect(kernelCalls("/api/v1/auth/login")).toEqual([]);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("the same for /setup and an invitation", async () => {
    for (const path of ["/setup?password=p&setupToken=t", "/invite/tok?login=a&password=p"]) {
      const res = await proxy(new NextRequest(`${WEB}${path}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).not.toMatch(/password|setupToken|login=/);
    }
  });

  it("a clean sign-in URL renders as before", async () => {
    const res = await proxy(
      new NextRequest(`${WEB}/login?returnTo=%2Fagents&error=sso.access_denied`),
    );
    expect(res.status).toBe(200);
  });
});

describe("other native form POSTs", () => {
  it("setup runs server side: cookies and a 303 home", async () => {
    const res = await formPost("/setup", {
      login: "admin",
      password: "a-long-password",
      displayName: " Admin ",
      orgName: "",
      setupToken: "",
    });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "", WEB).pathname).toBe("/");
    expect(res.headers.getSetCookie()).toEqual(SESSION_COOKIES);
    const body = JSON.parse(String(kernelCalls("/api/v1/setup").at(-1)?.init?.body));
    expect(body).toEqual({ login: "admin", password: "a-long-password", displayName: "Admin" });
  });

  it("a failed setup comes back with the kernel's error code only", async () => {
    setup = () => kernelError(403, "setup.token_invalid");
    const res = await formPost("/setup", { login: "a", password: "p", displayName: "A" });
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/\/setup\?error=setup\.token_invalid$/);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("any other page's form gets a 303 back to the page, without the kernel", async () => {
    const res = await formPost("/invite/tok", { login: "a", password: "p", displayName: "A" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/invite\/tok$/);
    expect(calls).toEqual([]);
  });

  it("a Next server action POST is not a native form submission", async () => {
    const res = await proxy(
      new NextRequest(`${WEB}/login`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "next-action": "abc" },
        body: "--x--",
      }),
    );
    expect(res.status).toBe(200);
    expect(kernelCalls("/api/v1/auth/login")).toEqual([]);
  });
});
