import type { QueryClient, UseQueryOptions } from "@tanstack/react-query";
import { type Agent, setupReady } from "../agents";
import type { ApiClientError } from "../api";
import type { ChannelConnection } from "../channels";
import { type ConnectorSummary, personalConnectors } from "../connectors";
import type { Conversation, ConversationEvent } from "../conversations";
import { myRole, type OrgRole, roleAtLeast } from "../members";
import { canEditAgent } from "../org-settings";
import type { Me } from "../session";
import { identitiesQuery, toolGrantsQuery } from "./account";
import { agentConnectorQueries, agentFormQueries, agentQuery, agentsQuery } from "./agents";
import { authSourcesQuery } from "./auth";
import { orgCatalogItemQuery, orgCatalogQuery } from "./catalog";
import { channelQuery, channelSchemaQuery, channelsQuery, orgExtensionsQuery } from "./channels";
import {
  attachmentLimitsQuery,
  connectorQuery,
  connectorsQuery,
  contributionsQuery,
  conversationFollowUps,
  conversationQuery,
  eventsQuery,
  filesQuery,
  modelsQuery,
  queueQuery,
  sandboxQuery,
} from "./conversation";
import { overviewQueries } from "./overview";
import { orgSettingsQuery } from "./settings";
import { conversationGroupsQuery, maybeMeQuery, readinessQuery } from "./shell";
import { skillQuery, skillsQuery } from "./skills";

/** What a route's queries are built from. */
export interface RouteCtx {
  /** The dynamic segments, decoded (`[...rest]` joined with `/`). */
  params: Record<string, string>;
  search: URLSearchParams;
  /** `null` on the public (auth) pages, which read no session first. */
  me: Me | null;
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
  /**
   * Reads that need the first wave's answers; run after it. It only prefetches (through `qc`) and
   * must not rely on throwing: `prefetchRoute` swallows a rejection, and what it started stays in
   * the cache as it is.
   */
  then?(ctx: RouteCtx, qc: QueryClient): Promise<void>;
  /** Why the entry prefetches nothing. */
  none?: string;
}

/**
 * A query of any data type as a route entry lists it (the options are not assignable to
 * `UseQueryOptions<unknown>` as they are: their callbacks take `T`).
 */
const q = <T>(o: UseQueryOptions<T, ApiClientError>) =>
  o as unknown as UseQueryOptions<unknown, ApiClientError>;

/** Whether the session's role in its current org reaches `min` (a page gated below it reads nothing). */
const atLeast = (me: Me | null, min: OrgRole): boolean =>
  me !== null && roleAtLeast(myRole(me), min);

/**
 * Every `page.tsx` under `app/(app)` and `app/(auth)`, one entry each (a test walks the app dir).
 * Patterns are string literals: the query checks read them statically.
 */
export const ROUTES: readonly RouteEntry[] = [
  {
    pattern: "/",
    // The overview, once the org is ready (until then the frame draws the setup home here and the
    // page reads nothing): readiness is the shell's read, so this waits for it.
    queries: () => [],
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId }, qc) => {
      if (orgId === null) return;
      const readiness = await qc.fetchQuery({ ...readinessQuery(orgId), retry: false });
      if (!setupReady(readiness)) return;
      await Promise.all(
        overviewQueries(orgId).map((o) => qc.prefetchQuery({ ...o, retry: false })),
      );
    },
  },
  {
    pattern: "/account/connections",
    queries: ({ orgId }) => (orgId === null ? [] : [q(connectorsQuery(orgId))]),
    // The list names the personal connectors: their details (this person's credential status).
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId }, qc) => {
      if (orgId === null) return;
      const list = qc.getQueryData<{ connectors: ConnectorSummary[] }>(
        connectorsQuery(orgId).queryKey,
      );
      if (list === undefined) return;
      await Promise.all(
        personalConnectors(list.connectors).map((a) =>
          qc.prefetchQuery({ ...connectorQuery(orgId, a.id), retry: false }),
        ),
      );
    },
  },
  {
    pattern: "/account/grants",
    queries: ({ orgId }) => (orgId === null ? [] : [q(toolGrantsQuery(orgId))]),
  },
  {
    pattern: "/account/identities",
    // No org needed: my identities, and the sign-in sources (which plugins offer 验证).
    queries: ({ me }) =>
      me === null ? [] : [q(identitiesQuery(me.account.id)), q(authSourcesQuery())],
  },
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
  {
    pattern: "/agents",
    queries: ({ orgId }) => (orgId === null ? [] : [q(agentsQuery(orgId))]),
  },
  {
    pattern: "/agents/[id]",
    queries: ({ orgId, params }) =>
      orgId === null || params.id === undefined ? [] : [q(agentQuery(orgId, params.id))],
    // A viewer who may change the agent also gets the form's reads, the tools of the connectors
    // it uses and the channel connections; anyone else the read-only view (the agent only).
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params, me }, qc) => {
      const id = params.id;
      if (orgId === null || id === undefined || me === null) return;
      const agent = qc.getQueryData<Agent>(agentQuery(orgId, id).queryKey);
      if (agent === undefined || !canEditAgent(me, agent)) return;
      await Promise.all(
        [
          ...agentFormQueries(orgId, id),
          ...agentConnectorQueries(orgId, agent),
          q(channelsQuery(orgId)),
        ].map((o) => qc.prefetchQuery({ ...o, retry: false })),
      );
    },
  },
  {
    pattern: "/agents/new",
    // Members up (a guest gets no access and nothing is read).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : agentFormQueries(orgId),
  },
  { pattern: "/bind/[token]", queries: () => [], none: "pending migration" },
  {
    pattern: "/catalog",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(orgCatalogQuery(orgId))],
  },
  {
    pattern: "/catalog/[itemId]",
    queries: ({ orgId, me, params }) =>
      orgId === null || params.itemId === undefined || !atLeast(me, "member")
        ? []
        : [q(orgCatalogItemQuery(orgId, params.itemId))],
  },
  {
    pattern: "/catalog/[itemId]/install",
    // Org admins: the item and the org's extensions (the wizard's extension step).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.itemId === undefined || !atLeast(me, "admin")
        ? []
        : [q(orgCatalogItemQuery(orgId, params.itemId)), q(orgExtensionsQuery(orgId))],
  },
  {
    pattern: "/channels",
    // Org admins; the agents name the connections' agents (a section).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin")
        ? []
        : [q(channelsQuery(orgId)), q(agentsQuery(orgId))],
  },
  {
    pattern: "/channels/[id]",
    queries: ({ orgId, me, params }) =>
      orgId === null || params.id === undefined || !atLeast(me, "admin")
        ? []
        : [q(channelQuery(orgId, params.id)), q(agentsQuery(orgId))],
    // The connection's plugin names its schema.
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params }, qc) => {
      const id = params.id;
      if (orgId === null || id === undefined) return;
      const channel = qc.getQueryData<ChannelConnection>(channelQuery(orgId, id).queryKey);
      if (channel === undefined) return;
      await qc.prefetchQuery({ ...channelSchemaQuery(orgId, channel.plugin), retry: false });
    },
  },
  {
    pattern: "/channels/new",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin")
        ? []
        : [q(orgExtensionsQuery(orgId)), q(agentsQuery(orgId))],
  },
  {
    pattern: "/chat",
    // The sidebar's groups name the agent most recently talked to (the shell reads them too).
    queries: ({ orgId }) => (orgId === null ? [] : [q(conversationGroupsQuery(orgId))]),
    // Until the org can run, the frame draws the setup home here: the composer's reads wait for
    // readiness (the shell's read of it, shared) and are made only for a ready org.
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId }, qc) => {
      if (orgId === null) return;
      const readiness = await qc.fetchQuery({ ...readinessQuery(orgId), retry: false });
      if (!setupReady(readiness)) return;
      await Promise.all(
        [q(agentsQuery(orgId)), q(modelsQuery(orgId)), q(attachmentLimitsQuery(orgId))].map((o) =>
          qc.prefetchQuery({ ...o, retry: false }),
        ),
      );
    },
  },
  {
    pattern: "/chat/[conversationId]",
    queries: ({ orgId, params }) => {
      const id = params.conversationId;
      if (orgId === null || id === undefined) return [];
      return [
        q(conversationQuery(orgId, id)),
        q(eventsQuery(orgId, id)),
        q(agentsQuery(orgId)),
        q(modelsQuery(orgId)),
        q(queueQuery(orgId, id)),
        q(contributionsQuery(orgId)),
        q(filesQuery(orgId, id)),
        q(sandboxQuery(orgId, id)),
        q(connectorsQuery(orgId)),
        q(attachmentLimitsQuery(orgId)),
      ];
    },
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params, me }, qc) => {
      const id = params.conversationId;
      if (orgId === null || id === undefined) return;
      const events = qc.getQueryData<ConversationEvent[]>(eventsQuery(orgId, id).queryKey);
      const row = qc.getQueryData<Conversation>(conversationQuery(orgId, id).queryKey);
      if (events === undefined || row === undefined) return;
      await Promise.all(
        conversationFollowUps(orgId, id, events, row, me?.account.id).map((o) =>
          qc.prefetchQuery({ ...o, retry: false }),
        ),
      );
    },
  },
  {
    pattern: "/connectors",
    // Guests read the list too.
    queries: ({ orgId }) => (orgId === null ? [] : [q(connectorsQuery(orgId))]),
  },
  {
    pattern: "/connectors/[connectorId]",
    queries: ({ orgId, params }) =>
      orgId === null || params.connectorId === undefined
        ? []
        : [q(connectorQuery(orgId, params.connectorId))],
  },
  {
    pattern: "/connectors/install",
    // Org admins; `?template=<item id>` installs a catalog template: its item and the org's
    // extensions (the wizard's extension step).
    queries: ({ orgId, me, search }) => {
      const itemId = search.get("template") ?? "";
      return orgId === null || itemId === "" || !atLeast(me, "admin")
        ? []
        : [q(orgCatalogItemQuery(orgId, itemId)), q(orgExtensionsQuery(orgId))];
    },
  },
  { pattern: "/evals", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]/cases/[caseId]", queries: () => [], none: "pending migration" },
  { pattern: "/evals/[setId]/run", queries: () => [], none: "pending migration" },
  { pattern: "/evals/new", queries: () => [], none: "pending migration" },
  { pattern: "/evals/runs/[runId]", queries: () => [], none: "pending migration" },
  { pattern: "/inbox", queries: () => [], none: "pending migration" },
  { pattern: "/invite/[token]", queries: () => [q(maybeMeQuery())] },
  { pattern: "/login", queries: () => [q(authSourcesQuery()), q(maybeMeQuery())] },
  { pattern: "/p/[plugin]/[id]", queries: () => [], none: "pending migration" },
  { pattern: "/settings/extensions", queries: () => [], none: "pending migration" },
  { pattern: "/settings/members", queries: () => [], none: "pending migration" },
  { pattern: "/settings/models", queries: () => [], none: "pending migration" },
  {
    pattern: "/settings/organization",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(orgSettingsQuery(orgId))],
  },
  { pattern: "/settings/plugins", queries: () => [], none: "pending migration" },
  {
    pattern: "/settings/sandbox",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(orgSettingsQuery(orgId))],
  },
  { pattern: "/settings/tokens", queries: () => [], none: "pending migration" },
  { pattern: "/setup", queries: () => [], none: "pending migration" },
  {
    pattern: "/skills",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(skillsQuery(orgId))],
  },
  {
    pattern: "/skills/[id]",
    queries: ({ orgId, me, params }) =>
      orgId === null || params.id === undefined || !atLeast(me, "member")
        ? []
        : [q(skillQuery(orgId, params.id))],
  },
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
