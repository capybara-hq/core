import type { QueryClient, UseQueryOptions } from "@tanstack/react-query";
import type { ApiClientError } from "../api";
import type { Me } from "../session";

/** What a route's queries are built from. */
export interface RouteCtx {
  /** The dynamic segments, decoded (`[...rest]` joined with `/`). */
  params: Record<string, string>;
  search: URLSearchParams;
  me: Me;
  /** The current org; `null` without one. */
  orgId: string | null;
}

/**
 * One page of the app: the queries its first paint needs (web query cache spec §3.1). The layout
 * prefetches them on a document request; the page's view reads them by the same options.
 */
export interface RouteEntry {
  /** The app-dir form without the route group: `/chat/[conversationId]`, `/[...rest]`. */
  pattern: string;
  queries(ctx: RouteCtx): UseQueryOptions<unknown, ApiClientError>[];
  /** Reads that need the first wave's answers; run after it. */
  then?(ctx: RouteCtx, qc: QueryClient): Promise<void>;
  /** Why the entry prefetches nothing. */
  none?: string;
}

/**
 * Every `page.tsx` under `app/(app)` and `app/(auth)`, one entry each (a test walks the app dir).
 * Patterns are string literals: the query checks read them statically.
 */
export const ROUTES: readonly RouteEntry[] = [
  { pattern: "/", queries: () => [], none: "pending migration" },
  { pattern: "/account/connections", queries: () => [], none: "pending migration" },
  { pattern: "/account/grants", queries: () => [], none: "pending migration" },
  { pattern: "/account/identities", queries: () => [], none: "pending migration" },
  { pattern: "/admin", queries: () => [], none: "pending migration" },
  { pattern: "/admin/accounts", queries: () => [], none: "pending migration" },
  { pattern: "/admin/catalog", queries: () => [], none: "pending migration" },
  { pattern: "/admin/catalog/[itemId]", queries: () => [], none: "pending migration" },
  { pattern: "/admin/catalog/import", queries: () => [], none: "pending migration" },
  { pattern: "/admin/catalog/requests", queries: () => [], none: "pending migration" },
  { pattern: "/admin/extensions", queries: () => [], none: "pending migration" },
  { pattern: "/admin/extensions/[name]", queries: () => [], none: "pending migration" },
  { pattern: "/admin/extensions/install", queries: () => [], none: "pending migration" },
  { pattern: "/admin/marketplaces", queries: () => [], none: "pending migration" },
  { pattern: "/admin/marketplaces/entries", queries: () => [], none: "pending migration" },
  { pattern: "/admin/models", queries: () => [], none: "pending migration" },
  { pattern: "/admin/orgs", queries: () => [], none: "pending migration" },
  { pattern: "/admin/settings", queries: () => [], none: "pending migration" },
  { pattern: "/agents", queries: () => [], none: "pending migration" },
  { pattern: "/agents/[id]", queries: () => [], none: "pending migration" },
  { pattern: "/agents/new", queries: () => [], none: "pending migration" },
  { pattern: "/bind/[token]", queries: () => [], none: "pending migration" },
  { pattern: "/catalog", queries: () => [], none: "pending migration" },
  { pattern: "/catalog/[itemId]", queries: () => [], none: "pending migration" },
  { pattern: "/catalog/[itemId]/install", queries: () => [], none: "pending migration" },
  { pattern: "/channels", queries: () => [], none: "pending migration" },
  { pattern: "/channels/[id]", queries: () => [], none: "pending migration" },
  { pattern: "/channels/new", queries: () => [], none: "pending migration" },
  { pattern: "/chat", queries: () => [], none: "pending migration" },
  { pattern: "/chat/[conversationId]", queries: () => [], none: "pending migration" },
  { pattern: "/connectors", queries: () => [], none: "pending migration" },
  { pattern: "/connectors/[connectorId]", queries: () => [], none: "pending migration" },
  { pattern: "/connectors/install", queries: () => [], none: "pending migration" },
  { pattern: "/evals", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]/cases/[caseId]", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]/run", queries: () => [], none: "pending migration" },
  { pattern: "/evals/new", queries: () => [], none: "pending migration" },
  { pattern: "/evals/runs/[runId]", queries: () => [], none: "pending migration" },
  { pattern: "/inbox", queries: () => [], none: "pending migration" },
  { pattern: "/invite/[token]", queries: () => [], none: "pending migration" },
  { pattern: "/login", queries: () => [], none: "pending migration" },
  { pattern: "/p/[plugin]/[id]", queries: () => [], none: "pending migration" },
  { pattern: "/settings/extensions", queries: () => [], none: "pending migration" },
  { pattern: "/settings/members", queries: () => [], none: "pending migration" },
  { pattern: "/settings/models", queries: () => [], none: "pending migration" },
  { pattern: "/settings/organization", queries: () => [], none: "pending migration" },
  { pattern: "/settings/plugins", queries: () => [], none: "pending migration" },
  { pattern: "/settings/sandbox", queries: () => [], none: "pending migration" },
  { pattern: "/settings/tokens", queries: () => [], none: "pending migration" },
  { pattern: "/setup", queries: () => [], none: "pending migration" },
  { pattern: "/skills", queries: () => [], none: "pending migration" },
  { pattern: "/skills/[id]", queries: () => [], none: "pending migration" },
  { pattern: "/trajectories", queries: () => [], none: "pending migration" },
  { pattern: "/trajectories/[conversationId]", queries: () => [], none: "pending migration" },
  // Any other path under (app): its page throws `notFound()` (HTTP 404 inside the App Shell).
  { pattern: "/[...rest]", queries: () => [], none: "unknown route: 404" },
];

/** The catch-all entry: a path no page serves. */
export const UNKNOWN_ROUTE = "/[...rest]";

type Seg = { kind: "static"; name: string } | { kind: "param" | "rest"; name: string };

const segsOf = (pattern: string): Seg[] =>
  pattern
    .split("/")
    .filter((s) => s !== "")
    .map((s): Seg => {
      const rest = /^\[\.\.\.(.+)\]$/.exec(s);
      if (rest?.[1] !== undefined) return { kind: "rest", name: rest[1] };
      const param = /^\[(.+)\]$/.exec(s);
      if (param?.[1] !== undefined) return { kind: "param", name: param[1] };
      return { kind: "static", name: s };
    });

const RANK = { static: 0, param: 1, rest: 2 } as const;

/** Static before dynamic before catch-all, segment by segment from the left. */
function moreSpecific(a: Seg[], b: Seg[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return x !== undefined;
    if (RANK[x.kind] !== RANK[y.kind]) return RANK[x.kind] < RANK[y.kind];
  }
  return false;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function paramsOf(segs: Seg[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as Seg;
    if (seg.kind === "rest") {
      if (i >= parts.length) return null;
      params[seg.name] = parts.slice(i).map(decode).join("/");
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.kind === "static" && seg.name !== part) return null;
    if (seg.kind === "param") params[seg.name] = decode(part);
  }
  return segs.length === parts.length ? params : null;
}

/**
 * The entry that serves `path` (with or without its query), as Next picks it: static segments win
 * over dynamic ones, and `[...rest]` matches last. `null` when no page serves it.
 */
export function matchRoute(
  path: string,
  routes: readonly RouteEntry[] = ROUTES,
): { entry: RouteEntry; params: Record<string, string>; search: URLSearchParams } | null {
  const url = path.split("#")[0] ?? "";
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q + 1);
  const parts = pathname.split("/").filter((s) => s !== "");
  let best: { entry: RouteEntry; segs: Seg[]; params: Record<string, string> } | null = null;
  for (const entry of routes) {
    const segs = segsOf(entry.pattern);
    const params = paramsOf(segs, parts);
    if (params === null) continue;
    if (best === null || moreSpecific(segs, best.segs)) best = { entry, segs, params };
  }
  return best === null
    ? null
    : { entry: best.entry, params: best.params, search: new URLSearchParams(query) };
}
