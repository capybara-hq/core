import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { limitDefaults } from "../../admin/limit-defaults.js";
import { ApiError } from "../../errors.js";
import { AccountsService } from "../../identity/accounts.js";
import { DEPLOYMENT_SETTINGS_PATCH, SettingsService } from "../../identity/settings.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { MembersService } from "../../orgs/members.service.js";
import { OrgUpdateBody } from "../../orgs/orgs.schemas.js";
import { type Org, OrgsService } from "../../orgs/orgs.service.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { roleOf } from "./role.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;

const OrgId = z.string().min(1).max(100).describe("The org id (orgs.list).");

/** The value types of the per-org override records of `PUT /api/v1/admin/settings`. */
const OVERRIDES = DEPLOYMENT_SETTINGS_PATCH.shape;
const RunConcurrency = OVERRIDES.runConcurrencyOverrides.unwrap().valueType;
const SandboxLimits = OVERRIDES.sandboxLimitOverrides.unwrap().valueType;
const SubagentLimits = OVERRIDES.subagentLimitOverrides.unwrap().valueType;

/** The org's own limits (the overrides; a missing one follows the deployment default). */
async function limitsOf(settings: SettingsService, orgId: string) {
  const s = await settings.get();
  return {
    runConcurrency: s.runConcurrencyOverrides[orgId] ?? null,
    sandbox: s.sandboxLimitOverrides[orgId] ?? null,
    subagents: s.subagentLimitOverrides[orgId] ?? null,
  };
}

/**
 * Org operations of the `Platform` tool (spec §14.2): the super admin's view of every org (list,
 * get, the per-org limits) through their own private agent, and the conversation's org for its
 * members (read, rename, member list). Creating, deleting and transferring an org, invitations,
 * member role changes and removal stay on the web (human-only).
 */
@Injectable()
export class OrgsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(MembersService) private readonly members: MembersService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  private async org(orgId: string): Promise<Org> {
    const o = await this.orgs.get(orgId);
    if (!o) throw new ApiError("org.not_found", "Organization not found");
    return o;
  }

  /** The actor as `OrgsService.update` takes it (it re-checks the role under the org lock). */
  private async actor(ctx: OperationContext) {
    const a = await this.accounts.get(ctx.actorAccountId);
    if (!a) throw new ApiError("forbidden", "Your account no longer exists");
    return a;
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "orgs.list",
        description:
          "List every org on the platform (super admin), one compact row each: id, name, slug, member count and whether it has limits of its own. Also returns the deployment's default limits. Pages by 50: pass the returned next as params.cursor. Details and limits of one org come from orgs.get.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/orgs"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input) => {
          const [orgs, s] = await Promise.all([this.orgs.listAll(), this.settings.get()]);
          const own = (id: string) =>
            id in s.runConcurrencyOverrides ||
            id in s.sandboxLimitOverrides ||
            id in s.subagentLimitOverrides;
          return {
            ...pageOf(
              orgs.map((o) => ({
                id: o.id,
                name: o.name,
                slug: o.slug,
                memberCount: o.memberCount,
                ownLimits: own(o.id),
              })),
              startOf(input.cursor),
              PAGE,
            ),
            limitDefaults: limitDefaults(this.config),
          };
        },
      }),
      defineOperation({
        id: "orgs.get",
        description:
          "Read one org on the platform (super admin): name, slug, member count, when it was created, its own limits (null where it follows the deployment default) and the deployment defaults.",
        input: z.object({ orgId: OrgId }).strict(),
        example: { orgId: "00000000-0000-4000-8000-000000000000" },
        authz: { superAdmin: true },
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "org.not_found",
            next: "Look the org up with orgs.list and pass its id.",
          },
        ],
        run: async (input) => {
          const all = await this.orgs.listAll();
          const o = all.find((x) => x.id === input.orgId);
          if (!o) throw new ApiError("org.not_found", "Organization not found");
          return {
            org: o,
            limits: await limitsOf(this.settings, o.id),
            limitDefaults: limitDefaults(this.config),
          };
        },
      }),
      defineOperation({
        id: "orgs.set-limits",
        description:
          "Set an org's own limits (super admin): runConcurrency (concurrent runs), sandbox ({cpu, memoryMb} for sandboxes created from now on) and subagents ({maxDepth, maxConcurrentPerConversation, maxDispatchesPerRun, maxTokensPerRun}; 0 means no limit for the last two). Give only the limits to change; null drops the org's own value so it follows the deployment default (orgs.get shows both). A sandbox or subagents object replaces the org's whole entry.",
        input: z
          .object({
            orgId: OrgId,
            runConcurrency: RunConcurrency.optional(),
            sandbox: SandboxLimits.optional(),
            subagents: SubagentLimits.optional(),
          })
          .strict()
          .refine(
            (i) =>
              i.runConcurrency !== undefined ||
              i.sandbox !== undefined ||
              i.subagents !== undefined,
            { message: "give runConcurrency, sandbox or subagents" },
          ),
        example: { orgId: "00000000-0000-4000-8000-000000000000", runConcurrency: 8 },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/settings"],
        // one org's entries of the three override records, keyed by orgId; the deployment-wide
        // settings are admin.update-settings
        omits: [
          "orgCreation",
          "runConcurrencyOverrides",
          "priceCurrency",
          "sandboxLimitOverrides",
          "subagentLimitOverrides",
          "customConnectors",
          "customSkills",
          "orgMarketplaceBrowse",
          "uiTheme",
          "uiArrangement",
          "clientExtensions",
          "devicesAutoMode",
        ],
        extras: ["orgId", "runConcurrency", "sandbox", "subagents"],
        confirm: "platform",
        errors: [
          {
            code: "org.not_found",
            next: "Look the org up with orgs.list and pass its id.",
          },
          {
            code: "validation_failed",
            next: "Fix the limits as the message says (orgs.get shows the current ones).",
          },
        ],
        precheck: (i) => precheckBy(() => this.org(i.orgId)),
        summary: async (i) => {
          const name = await orElse(async () => named((await this.org(i.orgId)).name), i.orgId);
          const parts = [
            i.runConcurrency !== undefined && `runConcurrency=${i.runConcurrency ?? "default"}`,
            i.sandbox !== undefined &&
              `sandbox=${i.sandbox === null ? "default" : JSON.stringify(i.sandbox)}`,
            i.subagents !== undefined &&
              `subagents=${i.subagents === null ? "default" : JSON.stringify(i.subagents)}`,
          ].filter((p): p is string => typeof p === "string");
          return {
            zh: `修改组织「${name}」的限额：${parts.join("，")}`,
            en: `Set the limits of org "${name}": ${parts.join(", ")}`,
          };
        },
        run: async (input, ctx) => {
          await this.org(input.orgId);
          await this.settings.update(
            {
              ...(input.runConcurrency !== undefined && {
                runConcurrencyOverrides: { [input.orgId]: input.runConcurrency },
              }),
              ...(input.sandbox !== undefined && {
                sandboxLimitOverrides: { [input.orgId]: input.sandbox },
              }),
              ...(input.subagents !== undefined && {
                subagentLimitOverrides: { [input.orgId]: input.subagents },
              }),
            },
            ctx.actorAccountId,
            undefined,
            viaAgent("orgs.set-limits", ctx),
          );
          return {
            limits: await limitsOf(this.settings, input.orgId),
            limitDefaults: limitDefaults(this.config),
          };
        },
      }),
      defineOperation({
        id: "orgs.current",
        description:
          "Read this conversation's org: its id, name, slug, when it was created, and your role in it.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId"],
        confirm: "read",
        run: async (_input, ctx) => ({
          org: await this.org(ctx.orgId),
          role: await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId),
        }),
      }),
      defineOperation({
        id: "orgs.update",
        description:
          "Rename this conversation's org or change its slug (org admins). The slug is part of the org's links, so changing it breaks links people saved.",
        input: OrgUpdateBody.strict().refine((i) => i.name !== undefined || i.slug !== undefined, {
          message: "give name or slug",
        }),
        example: { name: "Acme Research" },
        authz: { orgAction: "org.update" },
        mirrors: ["PATCH /api/v1/orgs/:orgId"],
        confirm: "org",
        errors: [
          {
            code: "org.slug_taken",
            next: "Choose another slug; another org uses this one.",
          },
          {
            code: "validation_failed",
            next: "Fix the name or slug as the message says (slug: lower-case letters, digits and -).",
          },
        ],
        precheck: async (i, ctx) => {
          if (i.slug === undefined) return { ok: true };
          const taken = (await this.orgs.listAll()).find(
            (o) => o.slug === i.slug && o.id !== ctx.orgId,
          );
          return taken === undefined
            ? { ok: true }
            : { ok: false, code: "org.slug_taken", message: `The slug "${i.slug}" is taken` };
        },
        summary: async (i, ctx) => {
          const name = await orElse(async () => named((await this.org(ctx.orgId)).name), ctx.orgId);
          const parts = [
            i.name !== undefined && `name → "${named(i.name)}"`,
            i.slug !== undefined && `slug → ${named(i.slug)}`,
          ].filter((p): p is string => typeof p === "string");
          return {
            zh: `修改组织「${name}」：${parts.join("，")}`,
            en: `Update org "${name}": ${parts.join(", ")}`,
          };
        },
        run: async (input, ctx) => ({
          org: await this.orgs.update(
            ctx.orgId,
            input,
            await this.actor(ctx),
            undefined,
            viaAgent("orgs.update", ctx),
          ),
        }),
      }),
      defineOperation({
        id: "orgs.members",
        description:
          "List the members of this conversation's org, one compact row each: account id, display name, role, email and when they joined. Changing roles and removing members is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "org.members.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/members"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf(
            (await this.members.list(ctx.orgId)).map((m) => ({
              id: m.account.id,
              name: m.account.displayName,
              state: m.role,
              email: m.account.email,
              joinedAt: m.joinedAt,
              ...(m.anonymous && { anonymous: true }),
            })),
            startOf(input.cursor),
            PAGE,
          ),
      }),
    ]);
  }
}
