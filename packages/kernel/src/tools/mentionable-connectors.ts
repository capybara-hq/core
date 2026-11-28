import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { AgentLookup } from "../agents/agent-lookup.js";
import type { AgentDefinition } from "../agents/definition.js";
import { ApiError } from "../errors.js";
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

/** Why a connector named in a message cannot be used (`conversation.connector_unavailable`). */
export type ConnectorRefusal = "not_found" | "needs_config" | "not_offered";

/** A connector a message names, as the agent's tools offer it now. */
export interface MentionedConnector {
  id: string;
  slug: string;
  name: string;
  /** The agent's offered tools of it (at least one). */
  tools: ResolvedTool[];
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

  /**
   * The agent's tools for a message that names connectors or their resources (composer inline
   * tokens spec §3.4), resolved once as the conversation's next step would resolve them
   * (`ToolRegistry.forAgent` with the definition's disabled tools and roster, the conversation's
   * source and its sandbox conversation), and each of `mentioned` with its offered tools. A
   * connector of which the agent is offered no tool refuses the message: 422
   * `conversation.connector_unavailable`, `details: [{ connectorId, reason }]`, every refused
   * connector in `mentioned` order: `not_found` (deleted, disabled, another org's), `needs_config`
   * (an org admin must configure it, and nothing else keeps it from the agent), `not_offered` (the
   * agent switches it off, none of its tools is enabled, or its connector extension is not
   * loaded). A personal credential the sender has not connected is no refusal: the tool call
   * answers with the connection card. Opens no connector session.
   */
  async resolveForMessage(
    orgId: string,
    agent: Pick<AgentDefinition, "disabledTools" | "subagents">,
    where: { source: ConversationSource; sandboxConversationId?: string | undefined },
    mentioned: readonly string[],
  ): Promise<{ tools: ResolvedTool[]; toolSearch: boolean; connectors: MentionedConnector[] }> {
    const disabled = agent.disabledTools ?? [];
    const resolved = await this.registry.forAgent(orgId, {
      disabledTools: disabled,
      subagents: agent.subagents,
      ...(where.sandboxConversationId !== undefined && {
        sandboxConversationId: where.sandboxConversationId,
      }),
      source: where.source,
    });
    const tools = resolved.tools;
    const toolSearch = resolved.toolSearch === true;
    if (mentioned.length === 0) return { tools, toolSearch, connectors: [] };
    const rows = await this.db
      .selectFrom("connectors")
      .select(["id", "slug", "name", "connector", "auth"])
      .where("org_id", "=", orgId)
      .where("id", "in", [...mentioned])
      .where("deleted_at", "is", null)
      .where("status", "=", "active")
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const connectors: MentionedConnector[] = [];
    const unoffered: typeof rows = [];
    const refused = new Map<string, ConnectorRefusal>();
    for (const id of mentioned) {
      const row = byId.get(id);
      if (!row) {
        refused.set(id, "not_found");
        continue;
      }
      const offered = connectorToolsFor(tools, id);
      if (offered.length > 0) {
        connectors.push({ id, slug: row.slug, name: row.name, tools: offered });
      } else {
        unoffered.push(row);
      }
    }
    if (unoffered.length > 0) {
      const setups = await connectorSetups(
        this.credentials,
        orgId,
        unoffered.map((r) => ({ id: r.id, auth: r.auth as unknown as ConnectorAuth })),
      );
      for (const r of unoffered) {
        const switchedOff = disabled.some(
          (d) => d.kind === "connector" && d.connectorId === r.id && d.tools === "all",
        );
        refused.set(
          r.id,
          setups.get(r.id) !== "ready" && !switchedOff && this.registry.findConnector(r.connector)
            ? "needs_config"
            : "not_offered",
        );
      }
    }
    if (refused.size > 0) {
      const details = mentioned.flatMap((connectorId) => {
        const reason = refused.get(connectorId);
        return reason === undefined ? [] : [{ connectorId, reason }];
      });
      throw new ApiError(
        "conversation.connector_unavailable",
        "A connector this message names cannot be used by this agent now; remove it and send again",
        details,
      );
    }
    return { tools, toolSearch, connectors };
  }
}
