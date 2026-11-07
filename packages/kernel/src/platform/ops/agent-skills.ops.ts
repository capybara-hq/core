import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AgentsService } from "../../agents/agents.service.js";
import { ApiError } from "../../errors.js";
import { SkillChangesService } from "../../skills/changes.service.js";
import { SkillInvoker } from "../../skills/invoke.js";
import {
  AgentSkillPathParams,
  AgentSkillsListParams,
  InvocableSkillsQuerySchema,
  SkillChangePathParams,
} from "../../skills/skills.schemas.js";
import { type SkillSummary, SkillsService } from "../../skills/skills.service.js";
import {
  type ConfirmClass,
  defineOperation,
  type OperationContext,
  type PrecheckResult,
} from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const AgentId = AgentSkillsListParams.shape.agentId;
const DESCRIPTION_MAX = 200;
const clip = (s: string): string =>
  s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX)}…` : s;

const skillRow = (s: SkillSummary) => ({
  id: s.id,
  name: s.name,
  state: "active",
  description: clip(s.description),
  version: s.currentVersion,
  manual: s.manual,
});

/**
 * The skills of one agent and the skill change inbox detail (`Platform` tool, spec §14): reads of
 * the agent's own skills and of the invocable ones, detaching a skill, and the detail of a pending
 * skill change as the inbox shows it. Deciding a change stays `human-only`.
 */
@Injectable()
export class AgentSkillsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(SkillChangesService) private readonly changes: SkillChangesService,
    @Inject(SkillInvoker) private readonly invoker: SkillInvoker,
  ) {}

  /** Class of deleting a skill: your own private agent is personal; a shared agent is the org's. */
  private async deleteClass(agentId: string, ctx: OperationContext): Promise<ConfirmClass> {
    const a = await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId);
    return a.visibility === "private" && a.ownerAccountId === ctx.actorAccountId
      ? "personal"
      : "org";
  }

  /** The route's refusals, read before the card: a visible agent, owned by the actor, with the skill. */
  private async deleteCheck(
    agentId: string,
    skillId: string,
    ctx: OperationContext,
  ): Promise<PrecheckResult> {
    const seen = await precheckBy(async () => {
      const a = await this.agents.get(ctx.orgId, agentId, ctx.actorAccountId);
      if (a.ownerAccountId !== ctx.actorAccountId) {
        throw new ApiError("forbidden", "Only the agent's owner can delete its skills");
      }
    });
    if (!seen.ok) return seen;
    const list = await this.skills.listForAgent(ctx.orgId, agentId);
    return list.some((s) => s.id === skillId)
      ? { ok: true }
      : { ok: false, code: "skill.not_found", message: "Skill not found" };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "agents.skills",
        description:
          "List the skills an agent wrote for itself (its own skills, not org or platform ones), by name: id, name, description, version and whether it is manual-only. Takes the agent id from agents.list.",
        input: z.object({ agentId: AgentId }).strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId/skills"],
        confirm: "read",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list: only agents you can see are readable.",
          },
        ],
        run: async (input, ctx) => {
          await this.agents.get(ctx.orgId, input.agentId, ctx.actorAccountId);
          return {
            items: (await this.skills.listForAgent(ctx.orgId, input.agentId)).map(skillRow),
          };
        },
      }),
      defineOperation({
        id: "agents.invocable-skills",
        description:
          "List the skills a person can invoke with / on an agent (its effective skills: org, platform and its own), by name: id, name, plugin, description, version Optionally pass a conversation of yours with that agent to include its trial drafts.",
        input: z
          .object({
            agentId: AgentId,
            conversationId: InvocableSkillsQuerySchema.shape.conversationId,
          })
          .strict(),
        example: { agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills"],
        confirm: "read",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list: only agents you can see are readable.",
          },
          {
            code: "conversation.not_found",
            next: "Pass one of your own conversations with this agent (conversations.list), or leave it out.",
          },
        ],
        run: async (input, ctx) => ({
          items: (
            await this.invoker.listFor(
              ctx.orgId,
              input.agentId,
              ctx.actorAccountId,
              input.conversationId,
            )
          ).map((s) => ({
            id: s.id,
            name: s.name,
            state: s.manual ? "manual" : "active",
            description: clip(s.description),
            version: s.version,
            ...(s.plugin !== undefined && { plugin: s.plugin }),
          })),
        }),
      }),
      defineOperation({
        id: "agents.delete-skill",
        description:
          "Delete one of an agent's own skills (soft delete; a pending change of the same name is cancelled and the name can be written again). Only the agent's owner can; takes the agent id from agents.list and the skill id from agents.skills. On your own private agent the person may remember it; on a shared agent every delete is confirmed.",
        input: z.object({ agentId: AgentId, skillId: AgentSkillPathParams.shape.skillId }).strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11",
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId"],
        confirm: "personal",
        // destructive: a shared agent's skill is asked as an org write, every time
        rememberable: false,
        confirmFor: (i, ctx) => this.deleteClass(i.agentId, ctx),
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list: only agents you can see are readable.",
          },
          {
            code: "forbidden",
            next: {
              orgAdmin:
                "Only the agent's owner can delete its skills; the owner can change it on the web.",
              member: "Only the agent's owner can delete its skills; ask the owner.",
            },
          },
          {
            code: "skill.not_found",
            next: "Check the skill id with agents.skills; it may already be deleted.",
          },
        ],
        precheck: (i, ctx) => this.deleteCheck(i.agentId, i.skillId, ctx),
        summary: async (i, ctx) => {
          const agent = await orElse(
            async () =>
              named(
                (await this.agents.get(ctx.orgId, i.agentId, ctx.actorAccountId)).definition.name,
              ),
            i.agentId,
          );
          const skill = await orElse(
            async () =>
              named(
                (await this.skills.listForAgent(ctx.orgId, i.agentId)).find(
                  (s) => s.id === i.skillId,
                )?.name ?? i.skillId,
              ),
            i.skillId,
          );
          return {
            zh: `删除智能体「${agent}」的技能「${skill}」`,
            en: `Delete skill "${skill}" of agent "${agent}"`,
          };
        },
        run: async (input, ctx) => {
          await this.changes.deleteAgentSkill(
            ctx.orgId,
            input.agentId,
            input.skillId,
            ctx.actorAccountId,
            undefined,
            viaAgent("agents.delete-skill", ctx),
          );
          return { id: input.skillId, deleted: true };
        },
      }),
      defineOperation({
        id: "skills.get-change",
        description:
          "Read one skill change a shared agent proposed, as the inbox shows it: the agent, the skill name and description, the version it would become, its file paths and sizes, who asked, its state and who decided. Never file contents: review those on the web, where you also decide it (agents never decide skill changes). Only the agent's owner and the person who asked can read it.",
        input: z.object({ changeId: SkillChangePathParams.shape.id }).strict(),
        example: { changeId: "6a1d3e5f-2b4c-4d70-8e91-0f2a4c6e8b13" },
        // approvals.decide is stricter than the service (a plain-member requester is refused by
        // the gate), on purpose
        authz: { orgAction: "approvals.decide" },
        mirrors: ["GET /api/v1/orgs/:orgId/skill-changes/:id"],
        renames: { changeId: "id" },
        confirm: "read",
        errors: [
          {
            code: "skill_change.not_found",
            next: "No change with this id is yours to read; the inbox lists those waiting for you (inbox.list).",
          },
        ],
        run: async (input, ctx) => {
          const d = await this.changes.get(ctx.orgId, input.changeId, ctx.actorAccountId);
          return {
            skillChange: {
              id: d.id,
              name: d.name,
              state: d.status,
              description: d.description,
              agent: d.agent,
              skillId: d.skillId,
              version: d.version,
              files: d.files.map((f) => ({ path: f.path, size: f.size })),
              requestedByName: d.requestedByName,
              conversationPath: d.conversationPath,
              decidedAt: d.decidedAt,
              createdAt: d.createdAt,
              ...(d.status === "pending" && {
                next: "Review the files and decide it on the web, in the inbox; agents never decide skill changes.",
              }),
            },
          };
        },
      }),
    ]);
  }
}
