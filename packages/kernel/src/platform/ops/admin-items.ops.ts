import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  AdminAgentListQuery,
  AdminConnectorListQuery,
  AgentIdParams,
  ConnectorIdParams,
  ConnectorStatusBody,
} from "../../admin/admin-items.schemas.js";
import { AdminAgents } from "../../agents/admin-agents.js";
import { AgentsService } from "../../agents/agents.service.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { MembersService } from "../../orgs/members.service.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { AdminConnectors } from "../../tools/admin-connectors.js";
import { ConnectorsService } from "../../tools/connectors.service.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

/**
 * Refusal of an item another org owns: the tool's results enter this org's event log, where
 * another org's items do not belong (Platform tool spec §6.1, §14.5 item 1).
 */
export const OTHER_ORG_ITEM =
  "This belongs to another organization; the Platform tool acts only on this conversation's organization. Use the admin console.";

const AgentIdInput = AgentIdParams.strict();
const ConnectorIdInput = ConnectorIdParams.strict();

/**
 * The super admin's agent and connector operations of the `Platform` tool (admin agents and
 * connectors spec §4.5): the admin console's views and writes, run through the same services as
 * the routes. Unlike the console they cover only the conversation's org: lists filter to it, and
 * reads and writes of another org's item are refused (Platform tool spec §6.1). The owner transfer
 * is excluded (human-only, as the org's own transfer route).
 */
@Injectable()
export class AdminItemsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AdminAgents) private readonly adminAgents: AdminAgents,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AdminConnectors) private readonly adminConnectors: AdminConnectors,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(MembersService) private readonly members: MembersService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The agent's admin detail when it is the conversation org's; else {@link OTHER_ORG_ITEM}. */
  private async agentOf(agentId: string, ctx: OperationContext) {
    const agent = await this.adminAgents.get(agentId);
    if (agent.orgId !== ctx.orgId) throw new ToolError(OTHER_ORG_ITEM);
    return agent;
  }

  /** The connector's admin detail when it is the conversation org's; else {@link OTHER_ORG_ITEM}. */
  private async connectorOf(connectorId: string, ctx: OperationContext) {
    const connector = await this.adminConnectors.get(connectorId);
    if (connector.orgId !== ctx.orgId) throw new ToolError(OTHER_ORG_ITEM);
    return connector;
  }

  /** A precheck from a read: its `ApiError` code, or `notFound` for another org's item. */
  private async precheck(read: () => Promise<unknown>, notFound: string): Promise<PrecheckResult> {
    try {
      await read();
      return { ok: true };
    } catch (e) {
      if (e instanceof ToolError) return { ok: false, code: notFound, message: e.message };
      if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "admin.agents-list",
        description:
          "List this org's agents as the admin console shows them (super admin): private ones too, with owner, visibility, whether the agent needs a new owner and the template it was created from. q searches the name; pages by limit (default 50), pass the returned next as after. Other orgs' agents are only in the admin console.",
        input: AdminAgentListQuery.pick({ q: true, after: true, limit: true }).strict(),
        example: { limit: 50 },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/agents"],
        confirm: "read",
        run: (input, ctx) => this.adminAgents.list({ ...input, orgId: ctx.orgId }),
      }),
      defineOperation({
        id: "admin.agent-get",
        description:
          "Read one agent of this org as the admin console shows it (super admin): its definition with the instructions in full, members, profile with quick action labels, versions count. Never its conversations or credentials.",
        input: AgentIdInput,
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/agents/:agentId"],
        confirm: "read",
        errors: [{ code: "agent.not_found", next: "Check the agent id with admin.agents-list." }],
        run: async (input, ctx) => ({ agent: await this.agentOf(input.agentId, ctx) }),
      }),
      defineOperation({
        id: "admin.agent-delete",
        description:
          "Delete an agent of this org on the platform's behalf (super admin), whoever owns it: its conversations stay readable but it can no longer be used, its eval runs stop and its pending skill changes are cancelled. The org's audit log records that the platform acted. The agent you are running as cannot be deleted.",
        input: AgentIdInput,
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/agents/:agentId"],
        confirm: "platform",
        errors: [
          { code: "agent.not_found", next: "Check the agent id with admin.agents-list." },
          {
            code: "agent.delete_current",
            next: "This is the agent you are running as: ask the person to delete it in the admin console, or delete a different agent.",
          },
        ],
        precheck: async (i, ctx) => {
          // the run's agent is the root conversation's: a sub-agent runs under its parent's agent
          const rootId = await rootConversationOf(this.kdb.db, ctx.conversationId);
          const root = await this.kdb.db
            .selectFrom("conversations")
            .select("agent_id")
            .where("id", "=", rootId)
            .executeTakeFirst();
          if (i.agentId === ctx.agentId || i.agentId === root?.agent_id) {
            return {
              ok: false,
              code: "agent.delete_current",
              message: "The agent you are running as cannot be deleted from here.",
            };
          }
          return this.precheck(() => this.agentOf(i.agentId, ctx), "agent.not_found");
        },
        summary: async (i, ctx) => {
          const n = await orElse(
            async () => named((await this.agentOf(i.agentId, ctx)).name),
            i.agentId,
          );
          return {
            zh: `以平台身份删除智能体「${n}」；它的对话仍可查看，但不能再使用`,
            en: `Delete agent "${n}" on the platform's behalf; its conversations stay readable but it can no longer be used`,
          };
        },
        run: async (input, ctx) => {
          await this.agentOf(input.agentId, ctx);
          await this.agents.softDeleteAsPlatform(
            input.agentId,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.agent-delete", ctx),
          );
          return { id: input.agentId, deleted: true };
        },
      }),
      defineOperation({
        id: "admin.connectors-list",
        description:
          "List this org's connectors as the admin console shows them (super admin): name, protocol, status, tool count, who created it and from which template. Never an endpoint, credential or whether anyone has one. status and q (name search) filter; pages by limit (default 50), pass the returned next as after. Other orgs' connectors are only in the admin console.",
        input: AdminConnectorListQuery.pick({
          status: true,
          q: true,
          after: true,
          limit: true,
        }).strict(),
        example: { limit: 50 },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/connectors"],
        confirm: "read",
        run: (input, ctx) => this.adminConnectors.list({ ...input, orgId: ctx.orgId }),
      }),
      defineOperation({
        id: "admin.connector-get",
        description:
          "Read one connector of this org as the admin console shows it (super admin): its endpoint with large fields as size and hash only, the auth type and who holds the credential (the org or each person), and its tools with their state and default policy. Never a credential, token or secret, nor whether any member has one.",
        input: ConnectorIdInput,
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/connectors/:connectorId"],
        confirm: "read",
        errors: [
          {
            code: "connector.not_found",
            next: "Check the connector id with admin.connectors-list.",
          },
        ],
        run: async (input, ctx) => ({
          connector: await this.connectorOf(input.connectorId, ctx),
        }),
      }),
      defineOperation({
        id: "admin.connector-set-status",
        description:
          "Disable or enable a connector of this org on the platform's behalf (super admin): status disabled takes its tools away from every agent until it is enabled again. Its endpoint and auth stay the org's to edit. The org's audit log records that the platform acted.",
        input: z
          .object({
            connectorId: ConnectorIdParams.shape.connectorId,
            status: ConnectorStatusBody.shape.status,
          })
          .strict(),
        example: {
          connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60",
          status: "disabled" as const,
        },
        authz: { superAdmin: true },
        mirrors: ["PATCH /api/v1/admin/connectors/:connectorId"],
        confirm: "platform",
        errors: [
          {
            code: "connector.not_found",
            next: "Check the connector id with admin.connectors-list.",
          },
        ],
        precheck: (i, ctx) =>
          this.precheck(() => this.connectorOf(i.connectorId, ctx), "connector.not_found"),
        summary: async (i, ctx) => {
          const n = await orElse(
            async () => named((await this.connectorOf(i.connectorId, ctx)).name),
            i.connectorId,
          );
          return i.status === "disabled"
            ? {
                zh: `以平台身份停用连接器「${n}」；智能体将失去其工具，直到重新启用`,
                en: `Disable connector "${n}" on the platform's behalf; agents lose its tools until it is enabled again`,
              }
            : {
                zh: `以平台身份启用连接器「${n}」`,
                en: `Enable connector "${n}" on the platform's behalf`,
              };
        },
        run: async (input, ctx) => {
          await this.connectorOf(input.connectorId, ctx);
          await this.connectors.setStatusAsPlatform(
            input.connectorId,
            input.status,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.connector-set-status", ctx),
          );
          return { connector: await this.adminConnectors.get(input.connectorId) };
        },
      }),
      defineOperation({
        id: "admin.connector-delete",
        description:
          "Delete a connector of this org on the platform's behalf (super admin): its credentials are deleted too and agents that use it lose its tools. Creating it again needs its credentials entered on the web. The org's audit log records that the platform acted.",
        input: ConnectorIdInput,
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/connectors/:connectorId"],
        confirm: "platform",
        errors: [
          {
            code: "connector.not_found",
            next: "Check the connector id with admin.connectors-list.",
          },
        ],
        precheck: (i, ctx) =>
          this.precheck(() => this.connectorOf(i.connectorId, ctx), "connector.not_found"),
        summary: async (i, ctx) => {
          const n = await orElse(
            async () => named((await this.connectorOf(i.connectorId, ctx)).name),
            i.connectorId,
          );
          return {
            zh: `以平台身份删除连接器「${n}」及其全部凭据；使用它的智能体将失去其工具`,
            en: `Delete connector "${n}" and all its credentials on the platform's behalf; agents that use it lose its tools`,
          };
        },
        run: async (input, ctx) => {
          await this.connectorOf(input.connectorId, ctx);
          await this.connectors.removeAsPlatform(
            input.connectorId,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.connector-delete", ctx),
          );
          return { id: input.connectorId, deleted: true };
        },
      }),
      defineOperation({
        id: "admin.org-members",
        description:
          "List the members of this conversation's org as the admin console reads them (super admin): account id, display name, email, role, when they joined and whether the account is the org's anonymous guest.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/orgs/:orgId/members"],
        confirm: "read",
        run: async (_input, ctx) => ({ members: await this.members.list(ctx.orgId) }),
      }),
    ]);
  }
}
