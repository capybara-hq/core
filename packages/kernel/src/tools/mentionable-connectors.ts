import { Inject, Injectable } from "@nestjs/common";
import { AgentLookup } from "../agents/agent-lookup.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { OrgContext } from "../orgs/org.guard.js";
import { connectorSetups } from "./connector-setup.js";
import { type ConnectorAuth, Credentials } from "./credentials.js";
import { type ResolvedTool, ToolRegistry } from "./registry.js";
import { READ_RESOURCE } from "./resources.js";

/**
 * One row of the composer's `@` menu (composer inline tokens spec §4): a connector of the org the
 * agent can be pointed at. `icon` is the connector's kernel icon URL
 * (`/api/v1/orgs/:orgId/connectors/:id/icon?v=…`), null when it shows none; `credential` is the
 * viewer's own credential state for a personal-credential connector, `none` otherwise;
 * `toolCount` counts the agent's offered tools of it (0 for `needs_config`); `resources` says
 * whether the agent is offered its `read_resource` tool.
 */
export interface MentionableConnector {
  id: string;
  slug: string;
  name: string;
  /**
   * Its own description (one language), else its platform template's English one; with the
   * template's, `descriptionZh` carries the Chinese one when the template has it (the web picks
   * by locale).
   */
  description?: string;
  descriptionZh?: string;
  icon: string | null;
  state: "ready" | "needs_config";
  credential: "connected" | "missing" | "none";
  toolCount: number;
  resources: boolean;
}

/** The tools of `tools` that come from connector `connectorId` (in their order). */
export function connectorToolsFor(
  tools: readonly ResolvedTool[],
  connectorId: string,
): ResolvedTool[] {
  return tools.filter((t) => t.source.kind === "connector" && t.source.connectorId === connectorId);
}

/**
 * The connectors an agent can be told to use from the web input box: the org's live, active
 * connectors of which the agent is offered at least one tool (`ToolRegistry.forAgent`, source
 * `web`), plus the `needs_config` ones the agent does not switch off as a whole (shown disabled).
 * Reads only the database and the credential store's key presence: no connector session is opened.
 */
@Injectable()
export class MentionableConnectorsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AgentLookup) private readonly agents: AgentLookup,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(Credentials) private readonly credentials: Credentials,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
  ) {}

  /**
   * The rows for `agentId` as `accountId` sees them in `org` (the org guard's context: its role
   * decides which icons the reader may see); an agent the account may not see (or another org's)
   * -> `agent.not_found`.
   */
  async list(
    org: Pick<OrgContext, "orgId" | "role">,
    accountId: string,
    agentId: string,
  ): Promise<{ connectors: MentionableConnector[] }> {
    const { orgId } = org;
    const agent = await this.agents.get(orgId, agentId, accountId);
    const disabled = agent.definition.disabledTools ?? [];
    // no conversation yet: the listing names no sandbox conversation, which only decides the
    // device-bound builtins, never a connector's tools
    const { tools } = await this.registry.forAgent(orgId, {
      disabledTools: disabled,
      source: "web",
    });
    const rows = await this.db
      .selectFrom("connectors")
      .select([
        "id",
        "slug",
        "name",
        "description",
        "connector",
        "auth",
        "platform_template_id",
        "catalog_item_id",
      ])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where("status", "=", "active")
      .orderBy("slug")
      .orderBy("id")
      .execute();
    if (rows.length === 0) return { connectors: [] };
    const setups = await connectorSetups(
      this.credentials,
      orgId,
      rows.map((r) => ({ id: r.id, auth: r.auth as unknown as ConnectorAuth })),
    );
    const shown = rows.flatMap((r) => {
      const state = setups.get(r.id) ?? "needs_config";
      const offered = connectorToolsFor(tools, r.id);
      if (state === "ready" && offered.length === 0) return [];
      // a needs_config one is shown unless the agent switches it off as a whole or its connector
      // extension is not loaded (forAgent would not offer it once configured either)
      if (
        state === "needs_config" &&
        (disabled.some(
          (d) => d.kind === "connector" && d.connectorId === r.id && d.tools === "all",
        ) ||
          !this.registry.findConnector(r.connector))
      ) {
        return [];
      }
      return [{ row: r, state, offered }];
    });
    if (shown.length === 0) return { connectors: [] };
    const scope = orgIconScope(org);
    const templateIds = shown.flatMap((s) =>
      s.row.platform_template_id ? [s.row.platform_template_id] : [],
    );
    const [urls, descriptions, credentials] = await Promise.all([
      this.icons.ofConnectors(
        shown.map((s) => ({
          id: s.row.id,
          templateId: s.row.platform_template_id ?? null,
          itemId: s.row.catalog_item_id ?? null,
        })),
        scope,
      ),
      this.icons.templateDescriptions(templateIds, scope),
      Promise.all(
        shown.map(async ({ row }) => {
          const auth = row.auth as unknown as ConnectorAuth;
          if (auth.type === "none" || auth.ownership !== "personal") return "none" as const;
          return this.credentials.status(orgId, row.id, auth, accountId);
        }),
      ),
    ]);
    return {
      connectors: shown.map(({ row, state, offered }, i) => {
        // its own description first, else its platform template's (as the connector pages)
        const template = row.platform_template_id
          ? descriptions.get(row.platform_template_id)
          : undefined;
        const own = row.description?.trim() ? row.description : null;
        const description = own ?? template?.description ?? null;
        const descriptionZh = own === null ? (template?.descriptionZh ?? null) : null;
        const ready = state === "ready";
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          ...(description !== null && { description }),
          ...(descriptionZh !== null && { descriptionZh }),
          icon: urls[i] ?? null,
          state,
          credential: credentials[i] ?? "none",
          toolCount: ready ? offered.length : 0,
          resources:
            ready &&
            offered.some(
              (t) =>
                t.source.kind === "connector" &&
                t.source.resources === true &&
                t.source.name === READ_RESOURCE,
            ),
        };
      }),
    };
  }
}
