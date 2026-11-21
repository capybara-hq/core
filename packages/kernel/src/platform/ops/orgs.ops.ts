import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { OrgAuditListQuery } from "../../admin/audit.schemas.js";
import { AuditLogService } from "../../admin/audit-log.service.js";
import { limitDefaults } from "../../admin/limit-defaults.js";
import { NetworkAllowanceBody, NetworkAllowanceParams } from "../../admin/org-network.schemas.js";
import { OrgNetworkAdmin } from "../../admin/org-network.service.js";
import { ApiError, type ErrorCode } from "../../errors.js";
import { AccountsService } from "../../identity/accounts.js";
import { DEPLOYMENT_SETTINGS_PATCH, SettingsService } from "../../identity/settings.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { type Invitation, InvitationsService } from "../../orgs/invitations.service.js";
import { MembersService } from "../../orgs/members.service.js";
import { OrgNetworkAllowances } from "../../orgs/network-allowances.service.js";
import {
  InvitationCreateBody,
  InvitationIdParams,
  MemberParams,
  MemberRoleBody,
  networkAllowanceView,
  OrgUpdateBody,
} from "../../orgs/orgs.schemas.js";
import { type Org, OrgsService } from "../../orgs/orgs.service.js";
import { type OrgRole, roleAtLeast } from "../../orgs/roles.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { SEALED_REVEAL_TTL_MS, SealedReveals } from "../sealed-reveals.js";
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

/** The role names a card summary uses. */
const ROLE_WORDS: Record<OrgRole, { zh: string; en: string }> = {
  owner: { zh: "所有者", en: "owner" },
  admin: { zh: "管理员", en: "admin" },
  member: { zh: "成员", en: "member" },
  guest: { zh: "访客", en: "guest" },
};

/** What `orgs.invite` returns in place of the token (model-visible English). */
export const INVITATION_LINK_NOTE = `The invitation link is shown once, on the web, to the person this call was made for, under the tool call in this conversation; they share it with the invitee. It is never shown to you. If it is not read within ${SEALED_REVEAL_TTL_MS / 3_600_000} hours it is lost: revoke the invitation (orgs.revoke-invitation) and invite again.`;

/**
 * Why a member operation through the tool is never offered (spec §7.2, maintainer decision Q2):
 * the actor's own membership (`member.self`), an owner or granting owner
 * (`member.owner_untouchable`), or a role above the actor's own (`member.role_above_actor`). Null:
 * allowed here; the service's own checks still run. A target that is no member is left to the
 * service (`member.not_found`).
 */
export function memberChangeRefusal(
  actor: { id: string; role: OrgRole | null },
  target: { id: string; role: OrgRole | null },
  role?: OrgRole,
): { code: ErrorCode; message: string } | null {
  if (target.id === actor.id) {
    return {
      code: "member.self",
      message: "The Platform tool never changes or removes your own membership",
    };
  }
  if (target.role === "owner" || role === "owner") {
    return {
      code: "member.owner_untouchable",
      message: "The Platform tool never touches an owner or makes anyone an owner",
    };
  }
  return role === undefined ? null : roleAboveActor(actor.role, role);
}

/** `member.role_above_actor` when `role` is above the actor's own (or the actor has none). */
export function roleAboveActor(
  actorRole: OrgRole | null,
  role: OrgRole,
): { code: ErrorCode; message: string } | null {
  return actorRole !== null && roleAtLeast(actorRole, role)
    ? null
    : {
        code: "member.role_above_actor",
        message: `The Platform tool never gives a role above your own (${actorRole ?? "none"})`,
      };
}

/** Throws a refusal as the {@link ApiError} of its code. */
function refuse(r: { code: ErrorCode; message: string } | null): void {
  if (r !== null) throw new ApiError(r.code, r.message);
}

/**
 * The member service's guard (`MemberWriteOptions.guard`): {@link memberChangeRefusal} on the roles
 * read under the org row lock, so a role that changed after the precheck is still refused.
 */
const memberGuard =
  (actorId: string, targetId: string, role?: OrgRole) =>
  (actorRole: OrgRole, targetRole: OrgRole): void =>
    refuse(
      memberChangeRefusal(
        { id: actorId, role: actorRole },
        { id: targetId, role: targetRole },
        role,
      ),
    );

/** The invitation as the tool shows it: never a token (the list has none; create's is sealed). */
const invitationView = (i: Invitation & { status?: string }) => ({
  id: i.id,
  role: i.role,
  ...(i.status !== undefined && { status: i.status }),
  createdBy: i.createdBy,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  revokedAt: i.revokedAt,
});

/**
 * Org operations of the `Platform` tool (spec §14.2): the super admin's view of every org (list,
 * get, the per-org limits) through their own private agent, and the conversation's org for its
 * members (read, rename, member list, the org audit log for its admins), and member management for
 * its admins (invite, revoke, role change, remove; platform web parity spec §7.2: never self, never
 * an owner, never above the actor). Creating, deleting and transferring an org stay on the web.
 */
@Injectable()
export class OrgsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(MembersService) private readonly members: MembersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(SealedReveals) private readonly reveals: SealedReveals,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
    @Inject(OrgNetworkAdmin) private readonly networkAdmin: OrgNetworkAdmin,
    @Inject(OrgNetworkAllowances) private readonly allowances: OrgNetworkAllowances,
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

  /** The precheck of a member operation: {@link memberChangeRefusal} on the roles read now. */
  private async memberCheck(
    ctx: OperationContext,
    targetId: string,
    role?: OrgRole,
  ): Promise<PrecheckResult> {
    const [actorRole, targetRole] = await Promise.all([
      roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId),
      roleOf(this.kdb.db, ctx.orgId, targetId),
    ]);
    const refused = memberChangeRefusal(
      { id: ctx.actorAccountId, role: actorRole },
      { id: targetId, role: targetRole },
      role,
    );
    return refused === null ? { ok: true } : { ok: false, ...refused };
  }

  /** The precheck of `orgs.invite`, and its run's check: never a role above the actor's. */
  private async inviteRefusal(ctx: OperationContext, role: OrgRole) {
    return roleAboveActor(await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId), role);
  }

  /** The member's display name for a card; the id when unknown. */
  private async memberName(accountId: string): Promise<string> {
    return orElse(async () => {
      const a = await this.accounts.get(accountId);
      return a === undefined || a === null ? accountId : named(a.displayName);
    }, accountId);
  }

  /** The org's allowance `id` (for a card and the remove precheck); none → the remove's 404. */
  private async allowance(orgId: string, id: string) {
    const a = (await this.networkAdmin.list(orgId)).find((x) => x.id === id);
    if (!a) {
      throw new ApiError(
        "org.network_allowance_not_found",
        "The organization has no such internal endpoint allowance",
      );
    }
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
          "devicesOutsideSandbox",
          "devicesNetwork",
          "attribution",
          "compaction",
          "externalSharing",
          "shareMaxExpiryDays",
          "htmlRenderCdnAllowlist",
          "promptSuggestions",
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
        id: "admin.org-network-allowances",
        description:
          "List an org's internal endpoint allowances (super admin): the hosts, wildcards, IPs or CIDRs and origins the org's extension requests may reach although they resolve to private or loopback addresses, oldest first, each with its id, entry and when it was added. Add one with admin.org-network-allowance-add, remove one with admin.org-network-allowance-remove.",
        input: z.object({ orgId: OrgId }).strict(),
        example: { orgId: "00000000-0000-4000-8000-000000000000" },
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/orgs/:orgId/network-allowances"],
        extras: ["orgId"],
        confirm: "read",
        errors: [
          {
            code: "org.not_found",
            next: "Look the org up with orgs.list and pass its id.",
          },
        ],
        run: async (input) => ({
          allowances: (await this.networkAdmin.list(input.orgId)).map(networkAllowanceView),
        }),
      }),
      defineOperation({
        id: "admin.org-network-allowance-add",
        description:
          "Let an org's extension requests reach an internal endpoint (super admin): entry is a hostname or *.domain wildcard (https, any port), an IP address or CIDR such as 10.1.0.0/16 (IP-literal URLs only), or an origin such as http://mcp.internal:8080 (exactly that scheme, host and port; plain http allowed). Link-local (cloud metadata), loopback and unspecified addresses are never allowed. Only a person widens: through this tool the add is always refused, and the super admin adds the endpoint in the admin console on the web; listing and removing work here.",
        input: NetworkAllowanceBody.extend({ orgId: OrgId }).strict(),
        example: {
          orgId: "00000000-0000-4000-8000-000000000000",
          entry: "http://mcp.internal:8080",
        },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/orgs/:orgId/network-allowances"],
        extras: ["orgId"],
        confirm: "platform",
        errors: [
          {
            code: "org.not_found",
            next: "Look the org up with orgs.list and pass its id.",
          },
          {
            code: "org.network_allowance_widen_not_allowed",
            next: "Add the internal endpoint yourself on the org's page in the admin console on the web.",
          },
        ],
        precheck: (i) => precheckBy(() => this.networkAdmin.checkAdd(i.orgId, i.entry, true)),
        summary: async (i) => {
          const name = await orElse(async () => named((await this.org(i.orgId)).name), i.orgId);
          const entry = named(i.entry.trim());
          return {
            zh: `允许组织「${name}」的扩展请求访问内部端点 ${entry}`,
            en: `Let the extension requests of org "${name}" reach the internal endpoint ${entry}`,
          };
        },
        run: async (input, ctx) => ({
          allowance: networkAllowanceView(
            await this.networkAdmin.add(
              input.orgId,
              input.entry,
              { accountId: ctx.actorAccountId },
              true,
              viaAgent("admin.org-network-allowance-add", ctx),
            ),
          ),
        }),
      }),
      defineOperation({
        id: "admin.org-network-allowance-remove",
        description:
          "Remove one of an org's internal endpoint allowances (super admin) by its id (admin.org-network-allowances): the org's extension requests to that endpoint are refused from the next request on. The org's audit log records it.",
        input: NetworkAllowanceParams.extend({ orgId: OrgId }).strict(),
        example: {
          orgId: "00000000-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000001",
        },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/orgs/:orgId/network-allowances/:id"],
        extras: ["orgId"],
        confirm: "platform",
        errors: [
          {
            code: "org.not_found",
            next: "Look the org up with orgs.list and pass its id.",
          },
          {
            code: "org.network_allowance_not_found",
            next: "List the org's allowances again with admin.org-network-allowances and pass one of their ids.",
          },
        ],
        precheck: (i) => precheckBy(() => this.allowance(i.orgId, i.id)),
        summary: async (i) => {
          const name = await orElse(async () => named((await this.org(i.orgId)).name), i.orgId);
          const entry = await orElse(
            async () => named((await this.allowance(i.orgId, i.id)).entry),
            i.id,
          );
          return {
            zh: `移除组织「${name}」的内部端点 ${entry}，该组织的扩展请求将无法再访问它`,
            en: `Remove the internal endpoint ${entry} of org "${name}"; the org's extension requests can no longer reach it`,
          };
        },
        run: async (input, ctx) => {
          await this.networkAdmin.remove(
            input.orgId,
            input.id,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.org-network-allowance-remove", ctx),
          );
          return { id: input.id, removed: true };
        },
      }),
      defineOperation({
        id: "orgs.network-allowances",
        description:
          "Read this conversation's org's internal endpoint allowances (org admins, read-only): the hosts, wildcards, IPs or CIDRs and origins a super admin lets the org's extension requests reach although they resolve to private or loopback addresses. An extension request to an internal endpoint not listed is refused; only a super admin can add one.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.update" },
        mirrors: ["GET /api/v1/orgs/:orgId/network-allowances"],
        confirm: "read",
        run: async (_input, ctx) => ({
          allowances: (await this.allowances.list(ctx.orgId)).map(networkAllowanceView),
        }),
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
          "List the members of this conversation's org, one compact row each: account id, display name, role, email and when they joined. Org admins change roles with orgs.set-member-role and remove members with orgs.remove-member. Pages by 50: pass the returned next as params.cursor.",
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
      defineOperation({
        id: "orgs.invitations",
        description:
          "List the invitations of this conversation's org (org admins), oldest first: id, role, status (pending, accepted, expired or revoked), who created it and when, when it expires. Never the link: an invitation's link is shown only once, to the person who approved its creation.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "org.invitations.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/invitations"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf(
            (await this.invitations.list(ctx.orgId)).map(invitationView),
            startOf(input.cursor),
            PAGE,
          ),
      }),
      defineOperation({
        id: "orgs.invite",
        description:
          "Invite a person into this conversation's org (org admins) with a role: admin, member or guest (never owner; never above your own role). expiresInHours is 1 to 720 (default 168). You never see the link: it is shown once, on the web, to the person the call is made for (under the tool call in the conversation), who shares it with the invitee. If it is not read within 24 hours it is lost: revoke the invitation (orgs.revoke-invitation) and invite again.",
        input: InvitationCreateBody.strict(),
        example: { role: "member" },
        authz: { orgAction: "org.invitations.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/invitations"],
        confirm: "org",
        rememberable: false,
        revealsToApprover: "invitation_link",
        errors: [
          {
            code: "member.role_above_actor",
            next: "Invite with a role no higher than your own, or ask an owner to invite on the web.",
          },
          {
            code: "invitation.create_needs_approval",
            next: "Call it from a conversation where you approve the call yourself, or invite on the web (the org's Members page).",
          },
          {
            code: "validation_failed",
            next: "Pass role admin, member or guest and expiresInHours from 1 to 720.",
          },
        ],
        precheck: async (i, ctx) => {
          const refused = await this.inviteRefusal(ctx, i.role);
          return refused === null ? { ok: true } : { ok: false, ...refused };
        },
        summary: (i) => {
          const h = i.expiresInHours;
          return {
            zh: `邀请一位${ROLE_WORDS[i.role].zh}加入本组织${h === undefined ? "" : `，${h} 小时后过期`}；批准后邀请链接仅向你显示一次`,
            en: `Invite a new ${ROLE_WORDS[i.role].en} into this org${h === undefined ? "" : `, expiring in ${h} hours`}; the invitation link is shown once to you after approval`,
          };
        },
        run: async (input, ctx) => {
          if (ctx.callId === undefined || ctx.runId === null) {
            // the link reaches the approver through the approved call; without one it could never
            // be shown, so nothing is created
            throw new ApiError(
              "invitation.create_needs_approval",
              "orgs.invite runs only as a Platform call you approve in a conversation",
            );
          }
          // the service re-checks the role under the org row lock (`forbidden`)
          refuse(await this.inviteRefusal(ctx, input.role));
          const to = {
            conversationId: ctx.conversationId,
            runId: ctx.runId,
            callId: ctx.callId,
            recipientAccountId: ctx.actorAccountId,
          };
          const { invitation } = await this.invitations.create(
            ctx.orgId,
            input,
            ctx.actorAccountId,
            undefined,
            {
              auditDetail: viaAgent("orgs.invite", ctx),
              inTransaction: (inv, token) => this.reveals.sealIn(ctx.orgId, inv.id, token, to),
            },
          );
          return { invitation: invitationView(invitation), link: INVITATION_LINK_NOTE };
        },
      }),
      defineOperation({
        id: "orgs.revoke-invitation",
        description:
          "Revoke an invitation of this conversation's org (org admins) by its id (orgs.invitations): its link stops working at once. An accepted invitation cannot be revoked (remove the member instead); revoking one already revoked does nothing.",
        input: z.object({ invitationId: InvitationIdParams.shape.id }).strict(),
        example: { invitationId: "00000000-0000-4000-8000-000000000000" },
        authz: { orgAction: "org.invitations.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/invitations/:id"],
        renames: { invitationId: "id" },
        confirm: "org",
        rememberable: false,
        errors: [
          {
            code: "invitation.invalid",
            next: "List the invitations with orgs.invitations and pass one of their ids.",
          },
          {
            code: "invitation.used",
            next: "The invitation was accepted; remove the member with orgs.remove-member if they should leave.",
          },
        ],
        summary: async (i, ctx) => {
          const inv = await orElse(
            async () =>
              (await this.invitations.list(ctx.orgId)).find((x) => x.id === i.invitationId),
            undefined,
          );
          const role = inv === undefined ? undefined : ROLE_WORDS[inv.role];
          return {
            zh: `撤销${role === undefined ? "" : `${role.zh}`}邀请 ${i.invitationId}，它的链接将立即失效`,
            en: `Revoke the ${role === undefined ? "" : `${role.en} `}invitation ${i.invitationId}; its link stops working at once`,
          };
        },
        run: async (input, ctx) => {
          await this.invitations.revoke(
            ctx.orgId,
            input.invitationId,
            ctx.actorAccountId,
            undefined,
            viaAgent("orgs.revoke-invitation", ctx),
          );
          return { id: input.invitationId, revoked: true };
        },
      }),
      defineOperation({
        id: "orgs.set-member-role",
        description:
          "Change a member's role in this conversation's org (org admins): guest, member or admin, never above your own role. Never offered: changing your own role, changing an owner's role or making anyone an owner (an owner does that on the web).",
        input: MemberParams.extend(MemberRoleBody.shape).strict(),
        example: { accountId: "00000000-0000-4000-8000-000000000000", role: "member" as const },
        authz: { orgAction: "org.members.manage" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/members/:accountId"],
        confirm: "org",
        rememberable: false,
        errors: [
          {
            code: "member.role_above_actor",
            next: "Choose a role no higher than your own, or ask an owner to change it on the web.",
          },
          {
            code: "member.self",
            next: "Your own membership is changed by you on the web, never through this tool.",
          },
          {
            code: "member.owner_untouchable",
            next: "Owners and ownership are changed by an owner on the web (the org's Members page), never through this tool.",
          },
          {
            code: "member.not_found",
            next: "List the members with orgs.members and pass one of their ids.",
          },
          {
            code: "member.anonymous_guest",
            next: "The anonymous guest has no role to change; switch the channel connection back to binding on the web if it is no longer wanted.",
          },
        ],
        precheck: (i, ctx) => this.memberCheck(ctx, i.accountId, i.role),
        summary: async (i) => {
          const name = await this.memberName(i.accountId);
          return {
            zh: `将成员「${name}」的角色改为${ROLE_WORDS[i.role].zh}`,
            en: `Change the role of member "${name}" to ${ROLE_WORDS[i.role].en}`,
          };
        },
        run: async (input, ctx) => {
          await this.members.changeRole(
            ctx.orgId,
            input.accountId,
            input.role,
            ctx.actorAccountId,
            undefined,
            {
              auditDetail: viaAgent("orgs.set-member-role", ctx),
              guard: memberGuard(ctx.actorAccountId, input.accountId, input.role),
            },
          );
          return { accountId: input.accountId, role: input.role };
        },
      }),
      defineOperation({
        id: "orgs.remove-member",
        description:
          "Remove a member from this conversation's org (org admins): they lose access at once; every session and personal access token of the account is revoked, their runs in the org stop, their devices and file shares in the org are removed, and the org agents they own pass to an owner for reassignment. Never offered: removing yourself or an owner.",
        input: MemberParams.strict(),
        example: { accountId: "00000000-0000-4000-8000-000000000000" },
        authz: { orgAction: "org.members.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/members/:accountId"],
        confirm: "org",
        rememberable: false,
        errors: [
          {
            code: "member.self",
            next: "Your own membership is changed by you on the web, never through this tool.",
          },
          {
            code: "member.owner_untouchable",
            next: "Owners and ownership are changed by an owner on the web (the org's Members page), never through this tool.",
          },
          {
            code: "member.not_found",
            next: "List the members with orgs.members and pass one of their ids.",
          },
          {
            code: "member.anonymous_guest",
            next: "The anonymous guest cannot be removed; switch the channel connection back to binding on the web if anonymous access is no longer wanted.",
          },
        ],
        precheck: (i, ctx) => this.memberCheck(ctx, i.accountId),
        summary: async (i) => {
          const name = await this.memberName(i.accountId);
          return {
            zh: `将成员「${name}」移出本组织，其访问权限立即失效`,
            en: `Remove member "${name}" from this org; their access ends at once`,
          };
        },
        run: async (input, ctx) => {
          await this.members.remove(ctx.orgId, input.accountId, ctx.actorAccountId, undefined, {
            auditDetail: viaAgent("orgs.remove-member", ctx),
            guard: memberGuard(ctx.actorAccountId, input.accountId),
          });
          return { accountId: input.accountId, removed: true };
        },
      }),
      defineOperation({
        id: "orgs.audit",
        description:
          "The audit log of this conversation's org (org admins), newest first: members and invitations, settings, agents, connectors, skills, plugins and extensions in the org, channels, schedules. Each event has its id, time, actor (id, name, email; null for the kernel itself), viaToken (done with a personal access token), viaAgent (done through the Platform tool), action and target; never the event's details. action filters by an action name or its prefix (e.g. org.member.). limit is 1 to 100 (default 20); pages by keyset: pass the returned next as params.after (null: no more).",
        input: OrgAuditListQuery.strict(),
        example: { limit: 20 },
        authz: { orgAction: "org.update" },
        mirrors: ["GET /api/v1/orgs/:orgId/audit"],
        confirm: "read",
        run: (input, ctx) => this.audit.list({ orgId: ctx.orgId }, input),
      }),
    ]);
  }
}
