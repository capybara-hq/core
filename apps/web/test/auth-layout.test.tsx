// Web query cache spec §3.1: the public (auth) pages prefetch their route's queries on a document
// request, without the shell and without a session read of their own.
import type { DehydratedState } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json } from "./support/api";
import { ME } from "./support/render";
import { serverRoutes as serverRoutesOnly } from "./support/server";

const { pendingBindingQuery } = await import("../src/lib/query/auth");
const { serverQueryClient, settledQuery } = await import("../src/lib/server/query");

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

// the layouts' design context imports the next-intl navigation (Link)
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** The kernel routes, with the auth layout's platform theme read (the built-in theme). */
const PLATFORM_THEME = "/api/v1/platform/theme";
const serverRoutes = (routes: Parameters<typeof serverRoutesOnly>[0]) =>
  serverRoutesOnly({ [`GET ${PLATFORM_THEME}`]: () => json(200, null), ...routes });

const needsSetup = vi.hoisted(() => ({ value: false as boolean | undefined }));
vi.mock("../src/lib/server-setup", () => ({ serverNeedsSetup: async () => needsSetup.value }));

const { default: AuthLayout } = await import("../src/app/(auth)/layout");
const { default: LoginLayout } = await import("../src/app/(auth)/login/layout");
const { default: BindLayout } = await import("../src/app/(auth)/bind/[token]/layout");
const { default: DeviceLayout } = await import("../src/app/(auth)/device/layout");

const layoutAt = (path: string) => {
  req.headers = new Headers({ "x-cap-path": path });
  return AuthLayout({ children: <p>page body</p> });
};
const stateOf = (element: unknown) =>
  (element as ReactElement<{ state: DehydratedState }>).props.state;
const dataOf = (state: DehydratedState, area: string) =>
  state.queries.find((q) => q.queryKey.includes(area))?.state;
const SOURCES = [{ plugin: "lark", label: "Lark" }];
const INVITE = {
  org: { id: "o9", name: "Initech" },
  role: "guest",
  expiresAt: "2026-10-29T00:00:00Z",
};

beforeEach(() => {
  req.headers = new Headers();
  needsSetup.value = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("the (auth) layout's first-load prefetch", () => {
  it("a document render of /login prefetches auth sources and maybeMe; a 401 /me does not redirect", async () => {
    const calls = serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
      "GET /api/v1/auth/sources": () => json(200, { sources: SOURCES }),
    });
    const state = stateOf(await layoutAt("/login?returnTo=%2Fagents"));
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/v1/auth/sources",
      "/api/v1/me",
      PLATFORM_THEME,
    ]);
    expect(dataOf(state, "maybeMe")).toMatchObject({ status: "success", data: null });
    expect(dataOf(state, "authSources")).toMatchObject({ status: "success", data: SOURCES });
  });

  it("a document render of /invite prefetches the preview and maybeMe; signed in, it is the account", async () => {
    const calls = serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/invitations/t1": () => json(200, INVITE),
    });
    const state = stateOf(await layoutAt("/invite/t1"));
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/v1/invitations/t1",
      "/api/v1/me",
      PLATFORM_THEME,
    ]);
    expect(dataOf(state, "maybeMe")).toMatchObject({ status: "success", data: ME });
    expect(dataOf(state, "invitation")).toMatchObject({ status: "success", data: INVITE });
  });

  it("another /me failure is dehydrated as an error, still without a redirect", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(500, { error: { code: "internal", message: "boom" } }),
      "GET /api/v1/invitations/t1": () => json(200, INVITE),
    });
    const state = stateOf(await layoutAt("/invite/t1"));
    expect(dataOf(state, "maybeMe")).toMatchObject({
      status: "error",
      error: { status: 500, code: "internal" },
    });
  });

  it("/setup reads nothing but the platform theme", async () => {
    const calls = serverRoutes({});
    await expect(layoutAt("/setup")).resolves.toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual([PLATFORM_THEME]);
  });

  it("the platform theme is dehydrated; a failed read is the built-in theme, not a failure", async () => {
    const THEME = { id: "t1", cssUrl: "/api/v1/themes/t1/1.0.0/r2/theme.css" };
    serverRoutes({ [`GET ${PLATFORM_THEME}`]: () => json(200, THEME) });
    expect(dataOf(stateOf(await layoutAt("/setup")), "platformTheme")).toMatchObject({
      status: "success",
      data: THEME,
    });
    serverRoutes({
      [`GET ${PLATFORM_THEME}`]: () => json(500, { error: { code: "internal", message: "x" } }),
    });
    expect(dataOf(stateOf(await layoutAt("/setup")), "platformTheme")).toMatchObject({
      status: "error",
    });
  });

  it("a document render of /bind prefetches the pending binding; signed out, no redirect here", async () => {
    serverRoutes({
      "GET /api/v1/bind/t1": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    const state = stateOf(await layoutAt("/bind/t1"));
    expect(dataOf(state, "pendingBinding")).toMatchObject({
      status: "error",
      error: { status: 401, code: "auth.required" },
    });
  });
});

describe("the login layout's decisions before anything renders", () => {
  const loginAt = (path: string) => {
    req.headers = new Headers({ "x-cap-path": path });
    return LoginLayout({ children: <p>page body</p> });
  };
  const signedIn = () => serverRoutes({ "GET /api/v1/me": () => json(200, ME) });

  it("a signed-in visitor goes to returnTo, never off-site or back to a sign-in page", async () => {
    signedIn();
    await expect(loginAt(`/login?returnTo=${encodeURIComponent("/agents")}`)).rejects.toThrow(
      /^REDIRECT \/agents$/,
    );
    await expect(
      loginAt(`/login?returnTo=${encodeURIComponent("https://evil.example")}`),
    ).rejects.toThrow(/^REDIRECT \/$/);
    // never back to a sign-in page (a loop); without a returnTo it goes home, the new conversation
    await expect(loginAt(`/login?returnTo=${encodeURIComponent("/login?x=1")}`)).rejects.toThrow(
      /^REDIRECT \/$/,
    );
    await expect(loginAt("/login")).rejects.toThrow(/^REDIRECT \/$/);
  });

  it("signed out, or the session read failing, renders the form", async () => {
    serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(loginAt("/login")).resolves.toBeTruthy();
    serverRoutes({
      "GET /api/v1/me": () => json(500, { error: { code: "internal", message: "boom" } }),
    });
    await expect(loginAt("/login")).resolves.toBeTruthy();
  });

  it("a deployment without an admin goes to setup first", async () => {
    needsSetup.value = true;
    serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(loginAt("/login")).rejects.toThrow(/^REDIRECT \/setup$/);
  });
});

describe("the bind layout's decision before anything renders", () => {
  const bindAt = (token: string) =>
    BindLayout({ children: <p>page body</p>, params: Promise.resolve({ token }) });
  const BINDING = {
    connectionId: "ch1",
    source: "fake-im:t1",
    externalId: "u-alice",
    displayName: "Alice Wong",
  };

  it("a signed-out visitor goes to sign-in and back here", async () => {
    serverRoutes({
      "GET /api/v1/bind/cap_bind_tok": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(bindAt("cap_bind_tok")).rejects.toThrow(
      `REDIRECT /login?returnTo=${encodeURIComponent("/bind/cap_bind_tok")}`,
    );
  });

  it("a binding, or any other answer, is the page's", async () => {
    serverRoutes({ "GET /api/v1/bind/cap_bind_tok": () => json(200, { binding: BINDING }) });
    await expect(bindAt("cap_bind_tok")).resolves.toBeTruthy();
    serverRoutes({
      "GET /api/v1/bind/cap_bind_tok": () =>
        json(404, { error: { code: "bind.invalid", message: "x" } }),
    });
    await expect(bindAt("cap_bind_tok")).resolves.toBeTruthy();
  });

  it("an answer the route's prefetch already has is not read again", async () => {
    const qc = serverQueryClient();
    const calls = serverRoutes({
      "GET /api/v1/bind/cap_bind_tok": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await qc.prefetchQuery({ ...pendingBindingQuery("cap_bind_tok"), retry: false });
    await expect(settledQuery(qc, pendingBindingQuery("cap_bind_tok"))).resolves.toMatchObject({
      error: { status: 401 },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the device layout's decision before anything renders", () => {
  const PAGE = "/device?code=BCDF-GHJK";
  const deviceAt = (path: string) => {
    req.headers = new Headers({ "x-cap-path": path });
    return DeviceLayout({ children: <p>page body</p> });
  };

  it("a signed-out visitor goes to sign-in and back here, the code included", async () => {
    serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(deviceAt(PAGE)).rejects.toThrow(
      `REDIRECT /login?returnTo=${encodeURIComponent(PAGE)}`,
    );
  });

  it("a signed-in visitor gets the page", async () => {
    serverRoutes({ "GET /api/v1/me": () => json(200, ME) });
    await expect(deviceAt(PAGE)).resolves.toBeTruthy();
  });
});
