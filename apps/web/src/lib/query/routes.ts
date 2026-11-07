import type { QueryClient, UseQueryOptions } from "@tanstack/react-query";
import { type Agent, type AgentTemplateView, setupReady } from "../agents";
import type { ApiClientError } from "../api";
import type { ChannelConnection } from "../channels";
import { maybeOwnTemplate, type OrgComponent, usableRows } from "../components";
import { type ConnectorSummary, canManageConnectors, personalConnectors } from "../connectors";
import type { Conversation } from "../conversations";
import type { EvalSetDetail } from "../evals";
import type { InboxItem } from "../inbox";
import { myRole, type OrgRole, roleAtLeast } from "../members";
import { canEditAgent } from "../org-settings";
import type { Me } from "../session";
import type { UiContributionItem, UiLocale } from "../ui";
import { identitiesQuery, preferencesQuery, toolGrantsQuery } from "./account";
import {
  adminAccountsQuery,
  adminExtensionsQuery,
  adminInboxQuery,
  adminModelsQuery,
  adminOrgsQuery,
  adminOverviewQuery,
  adminPurposesQuery,
  catalogItemQuery,
  catalogItemsQuery,
  deploymentRequestsQuery,
  deploymentSettingsQuery,
  extensionConfigQuery,
  marketplaceEntriesQuery,
  marketplacesQuery,
  pendingPluginsQuery,
  stagedImportQuery,
} from "./admin";
import {
  agentConnectorQueries,
  agentFormQueries,
  agentQuery,
  agentsQuery,
  agentTemplateQuery,
  agentTemplatesQuery,
  agentVersionsQuery,
  availableExtensionPointsQuery,
  extensionToolsQuery,
} from "./agents";
import { authSourcesQuery, invitationQuery, pendingBindingQuery } from "./auth";
import { orgCatalogItemQuery, orgCatalogQuery, orgMarketplaceEntriesQuery } from "./catalog";
import { channelQuery, channelSchemaQuery, channelsQuery, orgExtensionsQuery } from "./channels";
import { adminComponentsQuery, componentVersionsQuery, orgComponentsQuery } from "./components";
import {
  attachmentLimitsQuery,
  connectorKindsQuery,
  connectorQuery,
  connectorsQuery,
  contributionsQuery,
  conversationFollowUps,
  conversationQuery,
  type EventWindow,
  eventsQuery,
  filesQuery,
  modelsQuery,
  queueQuery,
  sandboxQuery,
} from "./conversation";
import {
  type EvalRunState,
  evalCaseQuery,
  evalRunQuery,
  evalRunsQuery,
  evalSetQuery,
  evalSetsQuery,
} from "./evals";
import { setupRequestQuery } from "./from-template";
import { inboxQuery, skillChangeQuery } from "./inbox";
import { membersQuery } from "./members";
import {
  extensionPointDefaultsQuery,
  invitationsQuery,
  orgFilePreviewersQuery,
  orgPurposesQuery,
  orgSettingsQuery,
  pluginInstallsQuery,
  serviceTokensQuery,
} from "./settings";
import { conversationGroupsQuery, maybeMeQuery, readinessQuery } from "./shell";
import { skillQuery, skillsQuery } from "./skills";
import { trajectoriesQuery, trajectoryFilters, trajectoryQuery } from "./trajectories";
import { uiViewQuery } from "./ui";

/** What a route's queries are built from. */
export interface RouteCtx {
  /** The dynamic segments, decoded (`[...rest]` joined with `/`). */
  params: Record<string, string>;
  search: URLSearchParams;
  /** `null` on the public (auth) pages, which read no session first. */
  me: Me | null;
  /** The current org; `null` without one. */
  orgId: string | null;
  /** The page's UI locale (reads that render text in it, such as an extension view). */
  locale: UiLocale;
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

/** Whether the session is a super admin's (the admin console reads nothing for anyone else). */
const superAdmin = (me: Me | null): boolean => me?.account.isSuperAdmin === true;

/** The admin 插件 head's counts: the plugins waiting for a confirmation and the pending requests. */
const pluginsHead = () => [q(pendingPluginsQuery()), q(deploymentRequestsQuery())];

/**
 * Every `page.tsx` under `app/(app)` and `app/(auth)`, one entry each (a test walks the app dir).
 * Patterns are string literals: the query checks read them statically.
 */
export const ROUTES: readonly RouteEntry[] = [
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
  {
    pattern: "/account/preferences",
    // No org needed: my preferences.
    queries: ({ me }) => (me === null ? [] : [q(preferencesQuery(me.account.id))]),
  },
  {
    pattern: "/admin",
    // Super admins (no org needed): the four numbers.
    queries: ({ me }) => (superAdmin(me) ? [q(adminOverviewQuery())] : []),
  },
  {
    pattern: "/admin/accounts",
    queries: ({ me }) => (superAdmin(me) ? [q(adminAccountsQuery())] : []),
  },
  {
    pattern: "/admin/extensions",
    queries: ({ me }) => (superAdmin(me) ? [q(adminExtensionsQuery())] : []),
  },
  {
    pattern: "/admin/extensions/[name]",
    // The list (the extension is found in it) and its deployment config (the Config tab).
    queries: ({ me, params }) =>
      superAdmin(me) && params.name !== undefined
        ? [q(adminExtensionsQuery()), q(extensionConfigQuery(params.name))]
        : [],
  },
  {
    pattern: "/admin/inbox",
    // Super admins (no org needed): what waits on the platform.
    queries: ({ me }) => (superAdmin(me) ? [q(adminInboxQuery())] : []),
  },
  {
    pattern: "/admin/models",
    queries: ({ me }) => (superAdmin(me) ? [q(adminModelsQuery()), q(adminPurposesQuery())] : []),
  },
  {
    pattern: "/admin/orgs",
    // The orgs and the deployment settings (their overrides).
    queries: ({ me }) =>
      superAdmin(me) ? [q(adminOrgsQuery()), q(deploymentSettingsQuery())] : [],
  },
  {
    pattern: "/admin/skills",
    // The platform skills and the orgs that name their named scopes (a section).
    queries: ({ me }) =>
      superAdmin(me) ? [q(adminComponentsQuery("skill")), q(adminOrgsQuery())] : [],
  },
  {
    pattern: "/admin/skills/[id]",
    // The skills (the component is one of them), its versions and the orgs (its scope, the dialog).
    queries: ({ me, params }) =>
      superAdmin(me) && params.id !== undefined
        ? [
            q(adminComponentsQuery("skill")),
            q(componentVersionsQuery("skill", params.id)),
            q(adminOrgsQuery()),
          ]
        : [],
  },
  {
    pattern: "/admin/connector-templates",
    queries: ({ me }) =>
      superAdmin(me) ? [q(adminComponentsQuery("connector_template")), q(adminOrgsQuery())] : [],
  },
  {
    pattern: "/admin/connector-templates/[id]",
    queries: ({ me, params }) =>
      superAdmin(me) && params.id !== undefined
        ? [
            q(adminComponentsQuery("connector_template")),
            q(componentVersionsQuery("connector_template", params.id)),
            q(adminOrgsQuery()),
          ]
        : [],
  },
  {
    pattern: "/admin/agent-templates",
    queries: ({ me }) =>
      superAdmin(me) ? [q(adminComponentsQuery("agent_template")), q(adminOrgsQuery())] : [],
  },
  {
    pattern: "/admin/agent-templates/[id]",
    queries: ({ me, params }) =>
      superAdmin(me) && params.id !== undefined
        ? [
            q(adminComponentsQuery("agent_template")),
            q(componentVersionsQuery("agent_template", params.id)),
            q(adminOrgsQuery()),
          ]
        : [],
  },
  {
    pattern: "/admin/plugins",
    // The items, the head's counts (pending plugins, requests), and the marketplaces and orgs
    // that name the rows' sources and named scopes (sections).
    queries: ({ me }) =>
      superAdmin(me)
        ? [q(catalogItemsQuery()), ...pluginsHead(), q(marketplacesQuery()), q(adminOrgsQuery())]
        : [],
  },
  {
    pattern: "/admin/plugins/[itemId]",
    // The item, the marketplaces (its source), the catalog (its dependencies, the head's count),
    // the orgs (its named scope, the scope dialog) and the platform components (the components
    // table's scope column and links).
    queries: ({ me, params }) =>
      superAdmin(me) && params.itemId !== undefined
        ? [
            q(catalogItemQuery(params.itemId)),
            q(marketplacesQuery()),
            q(catalogItemsQuery()),
            q(adminOrgsQuery()),
            q(adminComponentsQuery("skill")),
            q(adminComponentsQuery("connector_template")),
            q(adminComponentsQuery("agent_template")),
          ]
        : [],
  },
  {
    pattern: "/admin/plugins/import",
    // `?staging=<id>`: the staged import's review, the pending requests (a staging prepared for
    // an org's request defaults to that org) and the orgs (the scope); no staging: the source
    // step reads nothing.
    queries: ({ me, search }) => {
      const staging = search.get("staging") ?? "";
      return superAdmin(me) && staging !== ""
        ? [q(stagedImportQuery(staging)), q(deploymentRequestsQuery()), q(adminOrgsQuery())]
        : [];
    },
  },
  {
    pattern: "/admin/plugins/market",
    // The entries of the address's source and search, the marketplaces (the source tabs) and the
    // head's counts.
    queries: ({ me, search }) =>
      superAdmin(me)
        ? [
            q(
              marketplaceEntriesQuery(search.get("sourceId") ?? "", (search.get("q") ?? "").trim()),
            ),
            q(marketplacesQuery()),
            q(catalogItemsQuery()),
            ...pluginsHead(),
          ]
        : [],
  },
  {
    pattern: "/admin/plugins/pending",
    // The plugins waiting for a confirmation and the requests (the page and the head's counts),
    // the items (the head's count).
    queries: ({ me }) => (superAdmin(me) ? [...pluginsHead(), q(catalogItemsQuery())] : []),
  },
  {
    pattern: "/admin/plugins/sources",
    queries: ({ me }) => (superAdmin(me) ? [q(marketplacesQuery())] : []),
  },
  {
    pattern: "/admin/settings",
    queries: ({ me }) => (superAdmin(me) ? [q(deploymentSettingsQuery())] : []),
  },
  {
    pattern: "/agents",
    // Both tabs paint at once (ruling P4-14; the head counts both): the agents, and for members up
    // the members (the cards' owner names), the usable templates and the platform ones offered to
    // the org (a section). Guests get the agents only (no tabs).
    queries: ({ orgId, me }) =>
      orgId === null
        ? []
        : [
            q(agentsQuery(orgId)),
            ...(atLeast(me, "member")
              ? [
                  q(membersQuery(orgId)),
                  q(agentTemplatesQuery(orgId)),
                  q(orgComponentsQuery(orgId, { kind: "agent_template" })),
                ]
              : []),
          ],
    // Org admins: the detail of each template that may be the org's own (its 编辑 / 可共享 /
    // 删除 depend on `owned` and `shareable`), so the cards' menus paint complete
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, me }, qc) => {
      if (orgId === null || !atLeast(me, "admin")) return;
      const templates = qc.getQueryData<{ templates: AgentTemplateView[] }>(
        agentTemplatesQuery(orgId).queryKey,
      );
      if (templates === undefined) return;
      const offered = qc.getQueryData<{ components: OrgComponent[] }>(
        orgComponentsQuery(orgId, { kind: "agent_template" }).queryKey,
      );
      const ids = usableRows(templates.templates, offered?.components)
        .filter((r) => maybeOwnTemplate(r, orgId))
        .flatMap((r) => (r.item !== undefined ? [r.item.id] : []));
      await Promise.all(ids.map((id) => qc.prefetchQuery(agentTemplateQuery(orgId, id))));
    },
  },
  {
    pattern: "/agents/[id]",
    queries: ({ orgId, params }) =>
      orgId === null || params.id === undefined ? [] : [q(agentQuery(orgId, params.id))],
    // A viewer who may change the agent also gets every section's reads (whichever `?s=` opens,
    // so a section switch paints at once): the form's reads, the tools of the connectors it uses,
    // the channel connections and the attachment limits (Basics: whether uploads are on); anyone
    // else the read-only sections (the agent only).
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params, me }, qc) => {
      const id = params.id;
      if (orgId === null || id === undefined || me === null) return;
      const agent = qc.getQueryData<Agent>(agentQuery(orgId, id).queryKey);
      if (agent === undefined || !canEditAgent(me, agent)) return;
      // the owner who may not configure connectors sees the setup request's state (ruling P4-7)
      const asksAdmins =
        (agent.definition.pendingConnectors ?? []).length > 0 && !canManageConnectors(me);
      await Promise.all(
        [
          ...agentFormQueries(orgId, id),
          ...agentConnectorQueries(orgId, agent),
          q(channelsQuery(orgId)),
          q(attachmentLimitsQuery(orgId)),
          ...(asksAdmins ? [q(setupRequestQuery(orgId, id))] : []),
        ].map((o) => qc.prefetchQuery({ ...o, retry: false })),
      );
    },
  },
  {
    pattern: "/agents/new",
    // Members up (a guest gets no access and nothing is read).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : [...agentFormQueries(orgId), q(attachmentLimitsQuery(orgId))],
  },
  {
    pattern: "/agents/templates/[id]",
    // Members up (guests get no access): the template (a 404 when the org cannot use it) and the
    // components offered to the org (a platform template off here, the connector templates'
    // names; a section).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.id === undefined || !atLeast(me, "member")
        ? []
        : [q(agentTemplateQuery(orgId, params.id)), q(orgComponentsQuery(orgId, {}))],
    // An owner-org admin edits it: every section's reads (the models, the org skills, the
    // enabled extensions' tools, which web tools the org can serve, the usable templates)
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params, me }, qc) => {
      const id = params.id;
      if (orgId === null || id === undefined || !atLeast(me, "admin")) return;
      const t = qc.getQueryData<{ owned: boolean }>(agentTemplateQuery(orgId, id).queryKey);
      if (t?.owned !== true) return;
      await Promise.all(
        [
          q(modelsQuery(orgId)),
          q(skillsQuery(orgId)),
          q(extensionToolsQuery(orgId)),
          q(availableExtensionPointsQuery(orgId)),
          q(agentTemplatesQuery(orgId)),
        ].map((o) => qc.prefetchQuery({ ...o, retry: false })),
      );
    },
  },
  {
    pattern: "/bind/[token]",
    // The pending binding (signed out, the bind layout sends the visitor to sign-in first).
    queries: ({ params }) =>
      params.token === undefined ? [] : [q(pendingBindingQuery(params.token))],
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
    // The new conversation, the workspace home (`/chat` redirects here, maintainer decision
    // 2026-11-07).
    pattern: "/",
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
      const events = qc.getQueryData<EventWindow>(eventsQuery(orgId, id).queryKey)?.events;
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
    // Org admins: the connector kinds the wizard offers; `?template=<item id>` installs a catalog
    // template instead: its item and the org's extensions (the wizard's extension step).
    queries: ({ orgId, me, search }) => {
      const itemId = search.get("template") ?? "";
      if (orgId === null || !atLeast(me, "admin")) return [];
      return itemId === ""
        ? [q(connectorKindsQuery(orgId))]
        : [q(orgCatalogItemQuery(orgId, itemId)), q(orgExtensionsQuery(orgId))];
    },
  },
  {
    pattern: "/evals",
    // Org admins: the sets, and the agents for their names (a section).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin")
        ? []
        : [q(evalSetsQuery(orgId)), q(agentsQuery(orgId))],
  },
  {
    pattern: "/evals/[setId]",
    // Org admins: the set and its runs (a section), then the set's agent (a section).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.setId === undefined || !atLeast(me, "admin")
        ? []
        : [q(evalSetQuery(orgId, params.setId)), q(evalRunsQuery(orgId, params.setId))],
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, me, params }, qc) => {
      const setId = params.setId;
      if (orgId === null || setId === undefined || !atLeast(me, "admin")) return;
      const set = qc.getQueryData<EvalSetDetail>(evalSetQuery(orgId, setId).queryKey);
      if (set === undefined) return;
      await qc.prefetchQuery({ ...agentQuery(orgId, set.agentId), retry: false });
    },
  },
  {
    pattern: "/evals/[setId]/cases/[caseId]",
    // Org admins: the case, the set's name (a section) and the members (the starter's name).
    queries: ({ orgId, me, params }) =>
      orgId === null ||
      params.setId === undefined ||
      params.caseId === undefined ||
      !atLeast(me, "admin")
        ? []
        : [
            q(evalCaseQuery(orgId, params.setId, params.caseId)),
            q(evalSetQuery(orgId, params.setId)),
            q(membersQuery(orgId)),
          ],
  },
  {
    pattern: "/evals/[setId]/run",
    // Org admins: the set, the models and the purposes (a section), then the set's agent and its
    // versions (a section: the version options' saved times).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.setId === undefined || !atLeast(me, "admin")
        ? []
        : [q(evalSetQuery(orgId, params.setId)), q(modelsQuery(orgId)), q(orgPurposesQuery(orgId))],
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, me, params }, qc) => {
      const setId = params.setId;
      if (orgId === null || setId === undefined || !atLeast(me, "admin")) return;
      const set = qc.getQueryData<EvalSetDetail>(evalSetQuery(orgId, setId).queryKey);
      if (set === undefined) return;
      await Promise.all([
        qc.prefetchQuery({ ...agentQuery(orgId, set.agentId), retry: false }),
        qc.prefetchQuery({ ...agentVersionsQuery(orgId, set.agentId), retry: false }),
      ]);
    },
  },
  {
    pattern: "/evals/new",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin") ? [] : [q(agentsQuery(orgId))],
  },
  {
    pattern: "/evals/runs/[runId]",
    // Org admins: the run with its first page of results, then its set (a section: case titles).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.runId === undefined || !atLeast(me, "admin")
        ? []
        : [q(evalRunQuery(orgId, params.runId))],
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, me, params }, qc) => {
      const runId = params.runId;
      if (orgId === null || runId === undefined || !atLeast(me, "admin")) return;
      const state = qc.getQueryData<EvalRunState>(evalRunQuery(orgId, runId).queryKey);
      if (state === undefined) return;
      await qc.prefetchQuery({ ...evalSetQuery(orgId, state.run.setId), retry: false });
    },
  },
  {
    pattern: "/extensions",
    // Members: the extensions' state; org admins also the default providers and the file
    // previewers (sections).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : !atLeast(me, "admin")
          ? [q(orgExtensionsQuery(orgId))]
          : [
              q(orgExtensionsQuery(orgId)),
              q(extensionPointDefaultsQuery(orgId)),
              q(orgFilePreviewersQuery(orgId)),
            ],
  },
  {
    pattern: "/inbox",
    queries: ({ orgId }) => (orgId === null ? [] : [q(inboxQuery(orgId))]),
    // The first item is selected at once: its skill change's detail when it is one.
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId }, qc) => {
      if (orgId === null) return;
      const first = qc.getQueryData<{ items: InboxItem[] }>(inboxQuery(orgId).queryKey)?.items[0];
      if (first?.type !== "skill_change") return;
      await qc.prefetchQuery({ ...skillChangeQuery(orgId, first.skillChange.id), retry: false });
    },
  },
  {
    pattern: "/invite/[token]",
    // The invitation's public preview, and the session (`null` signed out: sign in or sign up).
    queries: ({ params }) =>
      params.token === undefined
        ? [q(maybeMeQuery())]
        : [q(invitationQuery(params.token)), q(maybeMeQuery())],
  },
  {
    pattern: "/login",
    // The sign-in sources, and the session (`null` signed out) the login layout redirects on.
    queries: () => [q(authSourcesQuery()), q(maybeMeQuery())],
  },
  {
    pattern: "/p/[plugin]/[id]",
    // Anyone in the org: the UI contributions, then the page's view when it is a schema view (an
    // embed's token handshake stays in the browser).
    queries: ({ orgId }) => (orgId === null ? [] : [q(contributionsQuery(orgId))]),
    // biome-ignore lint/suspicious/noThenProperty: RouteEntry's `then` step (controller ruling)
    then: async ({ orgId, params, locale }, qc) => {
      const { plugin, id } = params;
      if (orgId === null || plugin === undefined || id === undefined) return;
      const items = qc.getQueryData<UiContributionItem[]>(contributionsQuery(orgId).queryKey);
      const page = items?.find((c) => c.plugin === plugin && c.id === id && c.place === "page");
      if (page?.kind !== "view") return;
      await qc.prefetchQuery({ ...uiViewQuery(orgId, { plugin, id }, { locale }), retry: false });
    },
  },
  {
    pattern: "/plugins",
    // Members up; org admins also read the org's extensions (a row's 组织配置 and whether 启用
    // asks for input) and the marketplace entries (the 市场 tab; a 404 when browsing is off).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : [
            q(orgCatalogQuery(orgId)),
            ...(atLeast(me, "admin")
              ? [q(orgExtensionsQuery(orgId)), q(orgMarketplaceEntriesQuery(orgId, "", ""))]
              : []),
          ],
  },
  {
    pattern: "/plugins/[itemId]",
    // Members up; org admins also read the installs (the installed section) and the extensions.
    queries: ({ orgId, me, params }) =>
      orgId === null || params.itemId === undefined || !atLeast(me, "member")
        ? []
        : [
            q(orgCatalogItemQuery(orgId, params.itemId)),
            q(orgComponentsQuery(orgId, { itemId: params.itemId })),
            ...(atLeast(me, "admin")
              ? [q(pluginInstallsQuery(orgId)), q(orgExtensionsQuery(orgId))]
              : []),
          ],
  },
  {
    pattern: "/plugins/[itemId]/connectors",
    // Org admins: the item (the templates that miss a connector).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.itemId === undefined || !atLeast(me, "admin")
        ? []
        : [q(orgCatalogItemQuery(orgId, params.itemId))],
  },
  {
    pattern: "/plugins/[itemId]/enable",
    // Org admins: the item and the org's extensions (the wizard's extension step).
    queries: ({ orgId, me, params }) =>
      orgId === null || params.itemId === undefined || !atLeast(me, "admin")
        ? []
        : [q(orgCatalogItemQuery(orgId, params.itemId)), q(orgExtensionsQuery(orgId))],
  },
  {
    pattern: "/settings/members",
    // Members up; admins also read the invitations.
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : [q(membersQuery(orgId)), ...(atLeast(me, "admin") ? [q(invitationsQuery(orgId))] : [])],
  },
  {
    pattern: "/settings/models",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin")
        ? []
        : [q(orgPurposesQuery(orgId)), q(modelsQuery(orgId))],
  },
  {
    pattern: "/settings/organization",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(orgSettingsQuery(orgId))],
  },
  {
    pattern: "/settings/sandbox",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member") ? [] : [q(orgSettingsQuery(orgId))],
  },
  {
    pattern: "/settings/tokens",
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "admin") ? [] : [q(serviceTokensQuery(orgId))],
  },
  {
    pattern: "/setup",
    queries: () => [],
    none: "no kernel read before the form: the setup layout asks the kernel itself",
  },
  {
    pattern: "/skills",
    // Members up: the library and the platform skills offered to the org (a section).
    queries: ({ orgId, me }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : [q(skillsQuery(orgId)), q(orgComponentsQuery(orgId, { kind: "skill" }))],
  },
  {
    pattern: "/skills/[id]",
    queries: ({ orgId, me, params }) =>
      orgId === null || params.id === undefined || !atLeast(me, "member")
        ? []
        : [q(skillQuery(orgId, params.id))],
  },
  {
    pattern: "/trajectories",
    // Members up: the agents (the filter; a section) and the first page under the query's filters.
    queries: ({ orgId, me, search }) =>
      orgId === null || !atLeast(me, "member")
        ? []
        : [
            q(agentsQuery(orgId)),
            q(
              trajectoriesQuery(
                orgId,
                trajectoryFilters(search.get("agentId") ?? "", search.get("status") ?? ""),
              ),
            ),
          ],
  },
  {
    pattern: "/trajectories/[conversationId]",
    // Members up (the kernel decides who may see it): the latest runs (audited) and the members.
    queries: ({ orgId, me, params }) =>
      orgId === null || params.conversationId === undefined || !atLeast(me, "member")
        ? []
        : [q(trajectoryQuery(orgId, params.conversationId)), q(membersQuery(orgId))],
  },
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
