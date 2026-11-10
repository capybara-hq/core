import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AgentsService } from "../../agents/agents.service.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { SandboxFileReader } from "../../sandbox/sandbox-file-reader.js";
import {
  AgentSkillsService,
  isOrgAdmin,
  type RegisterOutcome,
  type ShareOutcome,
} from "../../skills/agent-skills.service.js";
import { SkillChangesService } from "../../skills/changes.service.js";
import { SkillInvoker } from "../../skills/invoke.js";
import { SKILL_PACKAGE_MAX_BYTES } from "../../skills/package.js";
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

/** A sandbox path (the sandbox tools' bound). */
const FILE_PATH_MAX = 4096;
const PATH_SHOWN_MAX = 200;
const shownPath = (p: string): string =>
  p.length > PATH_SHOWN_MAX ? `${p.slice(0, PATH_SHOWN_MAX)}…` : p;

const subagentRefusal = () =>
  new ApiError(
    "skill.subagent_register",
    "A sub-agent cannot register skills on its agent; only the agent the person talks with can.",
  );
const subagentShareRefusal = () =>
  new ApiError(
    "skill.subagent_register",
    "A sub-agent cannot share skills; only the agent the person talks with can.",
  );

/** File paths shown on a share card (the rest are counted). */
const SHARE_FILES_SHOWN = 10;

/** The model-facing result line of `agents.share-skill`. */
function sharedText(o: ShareOutcome, name: string): string {
  return o.kind === "shared"
    ? `Shared skill "${name}" with the organization: it is now an org skill (the person maintains it) that any agent of the org can select; this agent keeps using it.`
    : `Asked the org admins to share skill "${name}" with the organization; it waits for their decision in the inbox. Until then it stays this agent's own skill.`;
}

/** The model-facing result line of `agents.register-skill`. */
function registeredText(o: RegisterOutcome, files: number | null): string {
  const counted = files === null ? "" : ` (${files} file${files === 1 ? "" : "s"})`;
  if (o.kind === "proposed") {
    return `Proposed version ${o.version} of the org skill "${o.name}"${counted}; it waits for an org admin to approve it in the inbox. Until then only this conversation sees the new version.`;
  }
  const head = `${o.created ? "Created" : "Updated"} skill "${o.name}", version ${o.version}${counted}.`;
  return o.manualOnly
    ? `${head} It is manual-only: it is not in your skill catalog; a person invokes it with /${o.name} in any conversation with this agent.`
    : `${head} It applies to every conversation with this agent from now on; in this run, load it with the Skill tool (skill "${o.name}").`;
}

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
 * the agent's own skills and of the invocable ones, registering, deleting and sharing a skill,
 * and the detail of a skill change request as the inbox shows it. Deciding a request stays
 * `human-only` (org admins on the web).
 */
@Injectable()
export class AgentSkillsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(SkillChangesService) private readonly changes: SkillChangesService,
    @Inject(AgentSkillsService) private readonly agentSkills: AgentSkillsService,
    @Inject(SkillInvoker) private readonly invoker: SkillInvoker,
    @Inject(SandboxFileReader) private readonly files: SandboxFileReader,
    @Inject(KernelDb) private readonly db: KernelDb,
  ) {}

  /**
   * Class of registering a skill on the run's agent: `personal` on a private agent the actor owns
   * whose `skills.writePolicy` is not `ask`; otherwise `org` (asked every time, never remembered).
   * Also `org` when the registration may apply a version to a shared org skill at once (the actor
   * is an org admin maintaining one; the package name is not known before the card).
   */
  private async registerClass(ctx: OperationContext): Promise<ConfirmClass> {
    const a = await this.agents.get(ctx.orgId, ctx.agentId, ctx.actorAccountId);
    const personal =
      a.visibility === "private" &&
      a.ownerAccountId === ctx.actorAccountId &&
      a.definition.skills?.writePolicy !== "ask";
    if (!personal) return "org";
    return (await this.agentSkills.mayApplyOrgVersions(ctx.orgId, ctx.actorAccountId))
      ? "org"
      : "personal";
  }

  /**
   * The refusals read before anything touches the sandbox (the reader checks only the device):
   * a sub-agent conversation, then an actor who is not the agent's current owner.
   */
  private async registerCheck(ctx: OperationContext): Promise<void> {
    if ((await rootConversationOf(this.db.db, ctx.conversationId)) !== ctx.conversationId) {
      throw subagentRefusal();
    }
    await this.agentSkills.assertOwner(ctx.orgId, ctx.agentId, ctx.actorAccountId);
  }

  /**
   * The refusals of sharing read before the card: a sub-agent conversation, an actor who is not
   * the agent's current owner, a skill that is not one of the agent's own.
   */
  private async shareCheck(agentId: string, skillId: string, ctx: OperationContext) {
    if ((await rootConversationOf(this.db.db, ctx.conversationId)) !== ctx.conversationId) {
      throw subagentShareRefusal();
    }
    await this.agentSkills.assertOwner(ctx.orgId, agentId, ctx.actorAccountId);
    const skill = (await this.skills.listForAgent(ctx.orgId, agentId)).find(
      (s) => s.id === skillId,
    );
    if (!skill) throw new ApiError("skill.not_found", "Skill not found");
    return skill;
  }

  /** The file count of a registered version (null for a proposal or when the row is gone). */
  private async filesOf(o: RegisterOutcome): Promise<number | null> {
    if (o.kind !== "version") return null;
    const v = await this.db.db
      .selectFrom("skill_versions")
      .select("manifest")
      .where("skill_id", "=", o.skillId)
      .where("version", "=", o.version)
      .executeTakeFirst();
    return v?.manifest.files.length ?? null;
  }

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
          "List the skills a person can invoke with / on an agent (its effective skills: org, platform and its own), by name: id, name, state (manual for manual-only), description, version and the plugin. Optionally pass a conversation of yours with that agent to include its trial drafts.",
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
          "Delete one of an agent's own skills (soft delete; a pending change of the same name is cancelled and the name can be written again). Only the agent's owner can; takes the agent id from agents.list and the skill id from agents.skills. The person confirms every delete; it is never remembered.",
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
          await this.agentSkills.deleteAgentSkill(
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
        id: "agents.register-skill",
        description:
          "Register a zip package from your sandbox as one of this agent's own skills: a new skill, or the next version of this agent's skill with the same name. Build the package in the sandbox first: a zip with SKILL.md at its root (frontmatter name and description, then the instructions) plus any scripts or references, then pass its absolute path. Only the agent's owner can, and only from the conversation the person talks in (not a sub-agent). The new version applies to every conversation with this agent; in this run, load it with Skill. When the person maintains a shared org skill of the same name (and this agent has no own skill of it), the package is that skill's next version: an org admin applies it at once, anyone else's is proposed to the org admins and only this conversation uses it until approved.",
        input: z.object({ filePath: z.string().min(1).max(FILE_PATH_MAX) }).strict(),
        example: { filePath: "/workspace/out/weekly-report.zip" },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/skills"],
        // the agent is always the run's own (ctx.agentId); the zip comes from the sandbox
        omits: ["agentId", "uploadId"],
        extras: ["filePath"],
        confirm: "personal",
        confirmFor: (_i, ctx) => this.registerClass(ctx),
        errors: [
          {
            code: "skill.subagent_register",
            next: "Hand the skill files back to your parent agent; only the agent the person talks with registers skills.",
          },
          {
            code: "forbidden",
            next: "Only the agent's owner can add or update its skills; tell the person, and the owner can register the package (or upload it on the agent's page).",
          },
          {
            code: "agent.not_found",
            next: "This agent is deleted or no longer visible to the person; tell them.",
          },
          {
            code: "sandbox.file_invalid_path",
            next: "Pass the absolute path of the zip inside the sandbox (e.g. under the workspace); check it with Glob.",
          },
          {
            code: "sandbox.file_not_found",
            next: "Check the path with Glob, or build the zip first with Bash (cd into the skill directory, then zip -r ../<name>.zip .).",
          },
          {
            code: "sandbox.file_is_directory",
            next: "Archive the directory into one zip with Bash (zip -r) and pass the zip's path.",
          },
          {
            code: "sandbox.file_too_large",
            next: "The package is over 50 MB; leave out large or generated files, rebuild the zip and retry.",
          },
          {
            code: "skill.invalid_package",
            next: "Fix the package as the message says (SKILL.md at the zip's root with name and description frontmatter, allowed paths and sizes), rebuild the zip and retry.",
          },
          {
            code: "skill.agent_cap",
            next: "Register a new version of an existing skill (same name) instead, or ask the agent's owner to delete one of its skills (agents.skills lists them).",
          },
          {
            code: "skill.name_exists",
            next: "This agent uses an org skill with this name that only its maintainer can update; change the name in SKILL.md, rebuild the zip and register again, or ask the skill's maintainer.",
          },
          {
            code: "catalog.custom_disabled",
            next: "This deployment does not allow custom org skills, so this version of a shared skill cannot be registered; tell the person.",
          },
          {
            code: "skill.proposal_pending_elsewhere",
            next: "Another conversation has a proposed version of this skill waiting for an org admin; wait for that decision, or continue in that conversation.",
          },
          {
            code: "storage.unavailable",
            next: "File storage is unavailable; try again later, or tell the person to contact the super admin.",
          },
        ],
        precheck: (_i, ctx) => precheckBy(() => this.registerCheck(ctx)),
        summary: (i) => ({
          zh: `从 ${shownPath(i.filePath)} 为智能体登记技能`,
          en: `Register a skill on this agent from ${shownPath(i.filePath)}`,
        }),
        run: async (input, ctx) => {
          await this.registerCheck(ctx);
          const zip = await this.files.read({
            orgId: ctx.orgId,
            conversationId: ctx.conversationId,
            actorAccountId: ctx.actorAccountId,
            path: input.filePath,
            maxBytes: SKILL_PACKAGE_MAX_BYTES,
            signal: ctx.signal,
          });
          const o = await this.agentSkills.register(
            {
              orgId: ctx.orgId,
              agentId: ctx.agentId,
              accountId: ctx.actorAccountId,
              conversationId: ctx.conversationId,
              runId: ctx.runId,
              auditDetail: viaAgent("agents.register-skill", ctx),
            },
            zip,
          );
          const files = await this.filesOf(o);
          return {
            skill: {
              id: o.skillId,
              name: o.name,
              state: o.kind === "proposed" ? "pending" : o.manualOnly ? "manual" : "active",
              version: o.version,
              ...(files !== null && { files }),
              ...(o.kind === "proposed" && { requestId: o.requestId }),
            },
            message: registeredText(o, files),
          };
        },
      }),
      defineOperation({
        id: "agents.share-skill",
        description:
          "Share one of an agent's own skills with the organization, so any agent of the org can select it; the agent keeps using it and the person becomes its maintainer (later versions they register on their agents are proposed to the org admins). An org admin shares at once; anyone else's ask waits for an org admin's decision in the inbox. Only the agent's owner can; takes the agent id from agents.list and the skill id from agents.skills.",
        input: z.object({ agentId: AgentId, skillId: AgentSkillPathParams.shape.skillId }).strict(),
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11",
        },
        authz: { orgAction: "agents.create" },
        mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/skills/:skillId/share"],
        confirm: "personal",
        // an org admin's share changes the org's skill library at once: an org write, every time
        confirmFor: async (_i, ctx) =>
          (await isOrgAdmin(this.db.db, ctx.orgId, ctx.actorAccountId)) ? "org" : "personal",
        errors: [
          {
            code: "skill.subagent_register",
            next: "Tell your parent agent which skill to share; only the agent the person talks with shares skills.",
          },
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list: only agents you can see are readable.",
          },
          {
            code: "forbidden",
            next: "Only the agent's owner can share its skills; tell the person, and the owner can share it on the agent's page.",
          },
          {
            code: "skill.not_found",
            next: "Check the skill id with agents.skills: only the agent's own skills can be shared, and a shared one is no longer listed there.",
          },
          {
            code: "skill.name_exists",
            next: "The organization already has a skill with this name; register the package again under another name, then share that skill.",
          },
          {
            code: "catalog.custom_disabled",
            next: "This deployment does not allow custom org skills; the skill stays the agent's own. Tell the person.",
          },
          {
            code: "skill.share_pending",
            next: "Sharing this skill already waits for an org admin; nothing more to do until they decide.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(async () => {
            await this.shareCheck(i.agentId, i.skillId, ctx);
          }),
        summary: async (i, ctx) => {
          const skill = await orElse(
            async () => named((await this.shareCheck(i.agentId, i.skillId, ctx)).name),
            i.skillId,
          );
          // the card shows the files, so someone has seen what enters the org's skill library
          const files = await orElse(async () => {
            const s = (await this.skills.listForAgent(ctx.orgId, i.agentId)).find(
              (x) => x.id === i.skillId,
            );
            if (!s) return "";
            const v = await this.db.db
              .selectFrom("skill_versions")
              .select("manifest")
              .where("skill_id", "=", s.id)
              .where("version", "=", s.currentVersion)
              .executeTakeFirst();
            const paths = v?.manifest.files.map((f) => f.path) ?? [];
            const shown = paths.slice(0, SHARE_FILES_SHOWN).join(", ");
            const more = paths.length - SHARE_FILES_SHOWN;
            return more > 0 ? `${shown} (+${more})` : shown;
          }, "");
          const tail = files === "" ? "" : `: ${files}`;
          return {
            zh: `将技能「${skill}」共享到组织${tail}`,
            en: `Share skill "${skill}" with the organization${tail}`,
          };
        },
        run: async (input, ctx) => {
          const skill = await this.shareCheck(input.agentId, input.skillId, ctx);
          const o = await this.agentSkills.share(
            {
              orgId: ctx.orgId,
              agentId: input.agentId,
              accountId: ctx.actorAccountId,
              auditDetail: viaAgent("agents.share-skill", ctx),
            },
            input.skillId,
          );
          return {
            share: o,
            name: skill.name,
            state: o.kind === "shared" ? "shared" : "pending",
            message: sharedText(o, skill.name),
          };
        },
      }),
      defineOperation({
        id: "skills.get-change",
        description:
          "Read one skill change request as the inbox shows it: a share of an agent's skill with the org or a proposed version of a shared skill (kind), the agent, the skill name and description, the version, its file paths and sizes, who asked, its state and who decided. Never file contents: review those on the web, where org admins decide it (agents never decide skill changes). Only org admins and the person who asked can read it.",
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
            next: "No change with this id is yours to read; org admins see the pending ones in the inbox (inbox.list).",
          },
        ],
        run: async (input, ctx) => {
          const d = await this.changes.get(ctx.orgId, input.changeId, ctx.actorAccountId);
          return {
            skillChange: {
              id: d.id,
              kind: d.kind,
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
