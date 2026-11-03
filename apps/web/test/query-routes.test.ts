// @vitest-environment jsdom
// The route table (web query cache spec §3.1) and the page states of `usePageQuery` (§3.3).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hydrate, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/lib/api";
import { makeQueryClient, reviveDehydrated } from "../src/lib/query/client";
import { defineQuery } from "../src/lib/query/define";
import { keys } from "../src/lib/query/keys";
import { usePageQuery } from "../src/lib/query/page-query";
import { matchRoute, ROUTES } from "../src/lib/query/routes";
import { prefetchRoute } from "../src/lib/server/query";
import { json, stubApi } from "./support/api";
import { ME } from "./support/render";

vi.mock("server-only", () => ({}));
// `entry` replaces the matched route entry while set (a test's own `then`).
const override = vi.hoisted(() => ({
  entry: null as null | import("../src/lib/query/routes").RouteEntry,
}));
vi.mock("../src/lib/query/routes", async (original) => {
  const routes = await original<typeof import("../src/lib/query/routes")>();
  return {
    ...routes,
    matchRoute: (path: string) => {
      const m = routes.matchRoute(path);
      return m !== null && override.entry !== null ? { ...m, entry: override.entry } : m;
    },
  };
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

afterEach(() => vi.unstubAllGlobals());

const kernelError = (status: number, code: string) =>
  json(status, { error: { code, message: code } });

const APP = join(import.meta.dirname, "../src/app");

/** The app-dir pattern of every `page.tsx` under a route group (`/agents/[id]`, `/` for the root). */
function pagePatterns(group: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, [...segs, name]);
      else if (name === "page.tsx") out.push(`/${segs.join("/")}`);
    }
  };
  walk(join(APP, group), []);
  return out;
}

/** A concrete path for a pattern: each dynamic segment becomes `x<n>`. */
const pathOf = (pattern: string) => {
  let n = 0;
  return pattern.replace(/\[(\.\.\.)?[^\]]+\]/g, () => `x${++n}`);
};

describe("the route table", () => {
  it("every page.tsx under (app) and (auth) matches exactly one route entry", () => {
    const patterns = [...pagePatterns("(app)"), ...pagePatterns("(auth)")];
    expect(patterns.length).toBeGreaterThan(50);
    for (const pattern of patterns) {
      expect(
        ROUTES.filter((r) => r.pattern === pattern),
        pattern,
      ).toHaveLength(1);
      expect(matchRoute(pathOf(pattern))?.entry.pattern, pattern).toBe(pattern);
    }
    // and no entry without its page
    expect(ROUTES.map((r) => r.pattern).sort()).toEqual([...patterns].sort());
  });

  it("static segments win", () => {
    expect(matchRoute("/agents/new")?.entry.pattern).toBe("/agents/new");
    const m = matchRoute("/agents/a1?tab=runs");
    expect(m?.entry.pattern).toBe("/agents/[id]");
    expect(m?.params.id).toBe("a1");
    expect(m?.search.get("tab")).toBe("runs");
    expect(matchRoute("/evals/runs/r1")?.entry.pattern).toBe("/evals/runs/[runId]");
    expect(matchRoute("/evals/s1/run")?.entry.pattern).toBe("/evals/[setId]/run");
    expect(matchRoute("/chat/c%201")?.params.conversationId).toBe("c 1");
  });

  it("an unknown path under (app) resolves to [...rest]", async () => {
    const m = matchRoute("/nope/deeper");
    expect(m?.entry.pattern).toBe("/[...rest]");
    expect(m?.params.rest).toBe("nope/deeper");
    expect(m?.entry.none).toBe("unknown route: 404");
    await expect(prefetchRoute(makeQueryClient(), "/nope", { me: ME, orgId: "o1" })).resolves.toBe(
      "unknown",
    );
    await expect(
      prefetchRoute(makeQueryClient(), "/agents", { me: ME, orgId: "o1" }),
    ).resolves.toBe("ok");
  });
});

describe("prefetchRoute's then", () => {
  const key = keys.org("o1").agents();
  const first = defineQuery({
    key,
    fn: () => apiFetch<{ agents: unknown[] }>("/api/v1/orgs/o1/agents"),
    freshness: "orgConfig",
  });
  const entry = (then: () => Promise<void>) => ({
    pattern: "/agents",
    queries: () => [first as never],
    then,
  });
  afterEach(() => {
    override.entry = null;
  });

  it("a rejecting then does not fail the layout; its first wave stays cached", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }) });
    override.entry = entry(() => Promise.reject(new Error("then broke")));
    const qc = makeQueryClient();
    await expect(prefetchRoute(qc, "/agents", { me: ME, orgId: "o1" })).resolves.toBe("ok");
    expect(qc.getQueryData(key)).toEqual({ agents: [] });
  });

  it("the signed-out check still runs after a rejecting then", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/agents": () => kernelError(401, "auth.required"),
      "POST /api/v1/auth/refresh": () => kernelError(401, "auth.required"),
    });
    override.entry = entry(() => Promise.reject(new Error("then broke")));
    await expect(
      prefetchRoute(makeQueryClient(), "/agents", { me: ME, orgId: "o1" }),
    ).rejects.toThrow("REDIRECT /login?returnTo=%2Fagents");
  });
});

describe("usePageQuery", () => {
  const key = [...keys.org("o").all, "agents", "a1"];
  const agentQuery = defineQuery({
    key,
    fn: () => apiFetch<{ id: string }>("/api/v1/orgs/o/agents/a1"),
    freshness: "orgConfig",
  });

  it("stale data then a 404 is notFound", async () => {
    stubApi({ "GET /api/v1/orgs/o/agents/a1": () => kernelError(404, "agent.not_found") });
    const client = makeQueryClient();
    // what a server prefetch long ago left: stale by now, so the mount refetches
    hydrate(
      client,
      reviveDehydrated({
        mutations: [],
        queries: [
          {
            queryKey: key,
            queryHash: JSON.stringify(key),
            dehydratedAt: Date.now() - 60_000,
            state: {
              data: { id: "a1" },
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now() - 60_000,
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: "success",
              fetchStatus: "idle",
            },
          },
        ],
      }),
    );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => usePageQuery(agentQuery), { wrapper });
    expect(result.current).toEqual({ kind: "ready", data: { id: "a1" }, refreshing: true });
    await waitFor(() => expect(result.current).toEqual({ kind: "notFound" }));
  });

  it("no data yet is loading; another failure is an error with the kernel code and a retry", async () => {
    let status = 503;
    stubApi({
      "GET /api/v1/orgs/o/agents/a1": () =>
        status === 200 ? json(200, { id: "a1" }) : kernelError(status, "upstream_failed"),
    });
    const client = makeQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => usePageQuery(agentQuery), { wrapper });
    expect(result.current).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.kind).toBe("error"));
    const state = result.current as { kind: "error"; code: string; retry(): void };
    expect(state.code).toBe("upstream_failed");
    status = 200;
    state.retry();
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "ready", data: { id: "a1" }, refreshing: false }),
    );
  });
});
