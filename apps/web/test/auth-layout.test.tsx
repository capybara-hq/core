// Web query cache spec §3.1: the public (auth) pages prefetch their route's queries on a document
// request, without the shell and without a session read of their own.
import type { DehydratedState } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json } from "./support/api";
import { ME } from "./support/render";
import { serverRoutes } from "./support/server";

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

const { default: AuthLayout } = await import("../src/app/(auth)/layout");

const layoutAt = (path: string) => {
  req.headers = new Headers({ "x-cap-path": path });
  return AuthLayout({ children: <p>page body</p> });
};
const stateOf = (element: unknown) =>
  (element as ReactElement<{ state: DehydratedState }>).props.state;
const dataOf = (state: DehydratedState, area: string) =>
  state.queries.find((q) => q.queryKey.includes(area))?.state;
const SOURCES = [{ plugin: "lark", label: "Lark" }];

beforeEach(() => {
  req.headers = new Headers();
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
    expect(calls.map((c) => c.url).sort()).toEqual(["/api/v1/auth/sources", "/api/v1/me"]);
    expect(dataOf(state, "maybeMe")).toMatchObject({ status: "success", data: null });
    expect(dataOf(state, "authSources")).toMatchObject({ status: "success", data: SOURCES });
  });

  it("a signed-in visitor's maybeMe is the account", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    const state = stateOf(await layoutAt("/invite/t1"));
    expect(dataOf(state, "maybeMe")).toMatchObject({ status: "success", data: ME });
  });

  it("another /me failure is dehydrated as an error, still without a redirect", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(500, { error: { code: "internal", message: "boom" } }),
    });
    const state = stateOf(await layoutAt("/invite/t1"));
    expect(dataOf(state, "maybeMe")).toMatchObject({
      status: "error",
      error: { status: 500, code: "internal" },
    });
  });

  it("/setup and /bind read nothing", async () => {
    const calls = serverRoutes({});
    await expect(layoutAt("/setup")).resolves.toBeTruthy();
    await expect(layoutAt("/bind/t1")).resolves.toBeTruthy();
    expect(calls).toEqual([]);
  });
});
