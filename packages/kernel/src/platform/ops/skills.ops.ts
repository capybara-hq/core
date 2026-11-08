import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { OwnedItems } from "../../catalog/owned-items.js";
import {
  SkillCreateFields,
  SkillIdParams,
  SkillPathParams,
  SkillShareableSchema,
} from "../../skills/skills.schemas.js";
import { SkillsService } from "../../skills/skills.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const NoInput = z.object({}).strict();
const SkillId = z.object({ skillId: SkillPathParams.shape.id.max(100) }).strict();
const Create = SkillCreateFields.shape;
const OwnedSkillId = z.object({ skillId: SkillIdParams.shape.id }).strict();

/**
 * Skill library operations of the `Platform` tool (spec §7). The skill body can be long; `get`
 * returns it whole because reading it is the point of the call.
 */
@Injectable()
export class SkillsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

  /** The skill's name for a card summary; its id when it cannot be read. */
  private skillName(orgId: string, skillId: string): Promise<string> {
    return orElse(async () => named((await this.skills.get(orgId, skillId)).name), skillId);
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "skills.list",
        description:
          "List the skills the org can use, org skills and platform skills switched on in it. Each entry has an id, name, description, current version and where it came from.",
        input: NoInput,
        example: {},
        authz: { orgAction: "skills.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/skills"],
        confirm: "read",
        run: async (_input, ctx) => ({ skills: await this.skills.list(ctx.orgId) }),
      }),
      defineOperation({
        id: "skills.get",
        description:
          "Read one skill: its description, versions, file list and the current SKILL.md body. Takes the skill id from skills.list.",
        input: SkillId,
        example: { skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11" },
        authz: { orgAction: "skills.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/skills/:id"],
        renames: { skillId: "id" },
        confirm: "read",
        run: async (input, ctx) => this.skills.get(ctx.orgId, input.skillId),
      }),
      defineOperation({
        id: "skills.create",
        description:
          "Create an org skill from text: a name, a one-line description of when to use it, and the SKILL.md body. A skill of that name must not exist yet. Uploads of packages are done on the web.",
        // the route's text form, its bounds tightened for the model (a SKILL.md up to 100k chars)
        input: z
          .object({
            name: Create.name.unwrap().max(64),
            description: Create.description.unwrap(),
            body: Create.body.unwrap().min(1).max(100_000),
            shareable: Create.shareable,
          })
          .strict(),
        example: {
          name: "weekly-report",
          description: "Use when asked to write the weekly status report.",
          body: "# Steps\n\n1. Collect this week's updates.\n2. Write the report.",
        },
        authz: { orgAction: "skills.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/skills"],
        // packages are uploaded on the web
        omits: ["uploadId"],
        confirm: "org",
        errors: [
          {
            code: "skill.name_exists",
            next: "A skill of that name exists: pick another name, or read the existing one with skills.get.",
          },
          {
            code: "validation_failed",
            next: "Fix the SKILL.md as the message says (name, description, body), then call again.",
          },
          {
            code: "catalog.custom_disabled",
            next: {
              superAdmin:
                "The platform does not allow custom skills: allow them in the admin console under Settings, then call again.",
              orgAdmin:
                "The platform does not allow custom skills; ask the super admin, or use a platform skill from skills.list.",
              member:
                "The platform does not allow custom skills; use a platform skill from skills.list, or ask an org admin.",
            },
          },
        ],
        precheck: (i, ctx) => precheckBy(() => this.skills.checkCreateFromText(ctx.orgId, i)),
        summary: (i) =>
          i.shareable === true
            ? {
                zh: `新建组织技能「${i.name}」（可共享给其他组织）`,
                en: `Create org skill "${i.name}" (shared with other orgs)`,
              }
            : { zh: `新建组织技能「${i.name}」`, en: `Create org skill "${i.name}"` },
        run: async (input, ctx) =>
          this.skills.createFromText(ctx.orgId, ctx.actorAccountId, {
            name: input.name,
            description: input.description,
            body: input.body,
            ...(input.shareable !== undefined && { shareable: input.shareable }),
            auditDetail: viaAgent("skills.create", ctx),
          }),
      }),
      defineOperation({
        id: "skills.set-shareable",
        description:
          "Set whether an org skill may be shared with other orgs. Only the org's own skills can be changed; a skill that came from a platform plugin cannot.",
        input: OwnedSkillId.extend({ shareable: SkillShareableSchema.shape.shareable }).strict(),
        example: { skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11", shareable: true },
        authz: { orgAction: "skills.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/skills/:id/shareable"],
        renames: { skillId: "id" },
        confirm: "org",
        errors: [
          {
            code: "skill.not_found",
            next: "Check the skill id with skills.list; only the org's own skills can be changed or deleted here.",
          },
          {
            code: "catalog.not_owned",
            next: "Only a skill the org created can be shared; a platform skill or a copy of another owner's is not the org's to share.",
          },
        ],
        precheck: (i, ctx) => precheckBy(() => this.owned.previewSkillDelete(ctx.orgId, i.skillId)),
        summary: async (i, ctx) => {
          const n = await this.skillName(ctx.orgId, i.skillId);
          return i.shareable
            ? {
                zh: `允许把组织技能「${n}」共享给其他组织`,
                en: `Allow org skill "${n}" to be shared with other orgs`,
              }
            : {
                zh: `不再把组织技能「${n}」共享给其他组织`,
                en: `Stop sharing org skill "${n}" with other orgs`,
              };
        },
        run: async (input, ctx) => {
          await this.owned.setShareable(
            ctx.orgId,
            ctx.actorAccountId,
            { kind: "skill", id: input.skillId },
            input.shareable,
            { auditDetail: viaAgent("skills.set-shareable", ctx) },
          );
          return { id: input.skillId, shareable: input.shareable };
        },
      }),
      defineOperation({
        id: "skills.delete-preview",
        description:
          "Preview deleting an org skill (org admins): whether it is removed or handed to the platform because another org uses it, and which of the org's agents lose it. Show it to the person before skills.delete.",
        input: OwnedSkillId,
        example: { skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11" },
        authz: { orgAction: "skills.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/skills/:id/delete-preview"],
        renames: { skillId: "id" },
        confirm: "read",
        errors: [
          {
            code: "skill.not_found",
            next: "Check the skill id with skills.list; only the org's own skills can be changed or deleted here.",
          },
        ],
        run: async (input, ctx) => ({
          preview: await this.owned.previewSkillDelete(ctx.orgId, input.skillId),
        }),
      }),
      defineOperation({
        id: "skills.delete",
        description:
          "Delete an org skill. Agents of the org that use it lose it; a skill another org uses is handed to the platform instead of removed. Read skills.delete-preview first and show it to the person.",
        input: OwnedSkillId,
        example: { skillId: "0b9f2c4e-1d3a-4c55-9e0a-7a2f6d1c8b11" },
        authz: { orgAction: "skills.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/skills/:id"],
        renames: { skillId: "id" },
        confirm: "org",
        errors: [
          {
            code: "skill.not_found",
            next: "Check the skill id with skills.list; only the org's own skills can be changed or deleted here.",
          },
        ],
        precheck: (i, ctx) => precheckBy(() => this.owned.previewSkillDelete(ctx.orgId, i.skillId)),
        summary: async (i, ctx) => {
          const n = await this.skillName(ctx.orgId, i.skillId);
          const p = await orElse(() => this.owned.previewSkillDelete(ctx.orgId, i.skillId), null);
          const agents = p?.agents.length ?? 0;
          const handed = p?.outcome === "transferred";
          return {
            zh: `删除组织技能「${n}」：${agents} 个智能体将失去它${handed ? "；其他组织在用，将转为平台技能" : ""}`,
            en: `Delete org skill "${n}": ${agents} agents lose it${handed ? "; another org uses it, so it becomes a platform skill" : ""}`,
          };
        },
        run: async (input, ctx) => ({
          id: input.skillId,
          outcome: await this.owned.deleteSkill(ctx.orgId, ctx.actorAccountId, input.skillId, {
            auditDetail: viaAgent("skills.delete", ctx),
          }),
        }),
      }),
    ]);
  }
}
