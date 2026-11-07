import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { SkillsService } from "../../skills/skills.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { asToolError, viaAgent } from "./errors.js";

const NoInput = z.object({}).strict();
const SkillId = z.object({ skillId: z.string().min(1).max(100) }).strict();

/**
 * Skill library operations of the `Platform` tool (spec §7). The skill body can be long; `get`
 * returns it whole because reading it is the point of the call.
 */
@Injectable()
export class SkillsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {}

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
        confirm: "read",
        run: async (input, ctx) => asToolError(() => this.skills.get(ctx.orgId, input.skillId)),
      }),
      defineOperation({
        id: "skills.create",
        description:
          "Create an org skill from text: a name, a one-line description of when to use it, and the SKILL.md body. A skill of that name must not exist yet. Uploads of packages are done on the web.",
        input: z
          .object({
            name: z.string().min(1).max(64),
            description: z.string().min(1).max(1024),
            body: z.string().min(1).max(100_000),
            shareable: z.boolean().optional(),
          })
          .strict(),
        example: {
          name: "weekly-report",
          description: "Use when asked to write the weekly status report.",
          body: "# Steps\n\n1. Collect this week's updates.\n2. Write the report.",
        },
        authz: { orgAction: "skills.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/skills"],
        confirm: "org",
        errors: [
          {
            code: "skill.name_exists",
            next: "A skill of that name exists: pick another name, or read the existing one with skills.get.",
          },
        ],
        summary: (i) =>
          i.shareable === true
            ? {
                zh: `新建组织技能「${i.name}」（可共享给其他组织）`,
                en: `Create org skill "${i.name}" (shared with other orgs)`,
              }
            : { zh: `新建组织技能「${i.name}」`, en: `Create org skill "${i.name}"` },
        run: async (input, ctx) =>
          asToolError(() =>
            this.skills.createFromText(ctx.orgId, ctx.actorAccountId, {
              name: input.name,
              description: input.description,
              body: input.body,
              ...(input.shareable !== undefined && { shareable: input.shareable }),
              auditDetail: viaAgent("skills.create", ctx),
            }),
          ),
      }),
    ]);
  }
}
