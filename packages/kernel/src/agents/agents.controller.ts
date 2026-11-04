import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  AGENT_AVATAR_CONTENT_TYPES,
  AGENT_AVATAR_DOWNLOAD_TTL_SECONDS,
  AGENT_AVATAR_MAX_BYTES,
  AttachmentsService,
  type CreatedAttachment,
} from "../conversations/attachments.service.js";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AgentProfileService } from "./agent-profile.service.js";
import {
  AGENT_VISIBILITIES,
  AgentsService,
  type AgentVersionSummary,
  type AgentView,
  type AgentWarning,
} from "./agents.service.js";
import { AgentDefinitionSchema, AgentToolRef, DEFAULT_AGENT_TOOLS } from "./definition.js";
import { type AgentProfile, ProfileInputSchema } from "./profile.js";

const MemberIds = z.array(z.string().min(1).max(100)).max(1000);
const OwnerBody = z.object({ accountId: z.string().min(1).max(100) }).strict();

/** 创建时未给 `tools` → 默认工具（Ruling P7）；修改请求不注入默认值，版本里总是存显式的 tools。 */
const CreateDefinition = AgentDefinitionSchema.extend({
  tools: z.array(AgentToolRef).default(() => structuredClone(DEFAULT_AGENT_TOOLS)),
});

const CreateBody = z
  .object({
    definition: CreateDefinition,
    visibility: z.enum(AGENT_VISIBILITIES),
    memberIds: MemberIds.optional(),
    /** Without an avatar the agent gets a random preset. */
    profile: ProfileInputSchema.optional(),
  })
  .strict();
const ProfileBody = ProfileInputSchema.extend({
  /** The `profile.updatedAt` the client read; a different one → 409 `agent.profile_conflict`. */
  expectedUpdatedAt: z.string().min(1).max(40),
}).strict();
const AvatarUploadBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    contentType: z.enum(AGENT_AVATAR_CONTENT_TYPES),
    size: z.number().int().min(1).max(AGENT_AVATAR_MAX_BYTES),
  })
  .strict();
const UpdateBody = z
  .object({
    definition: AgentDefinitionSchema.optional(),
    visibility: z.enum(AGENT_VISIBILITIES).optional(),
    memberIds: MemberIds.optional(),
    /**
     * 乐观并发：编辑页打开时读到的 `currentVersion`。给出且与当前版本不同（别人已保存过）→ 409
     * `agent.version_conflict`，不覆盖别人的改动。不给时不检查（旧客户端）。
     */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

/** 服务令牌没有账号：以 null 作为 viewer，只看到 visibility='org' 的 agent。 */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

class AgentCreateBodyDto extends createZodDto(CreateBody, "AgentCreateBody") {}
class AgentUpdateBodyDto extends createZodDto(UpdateBody, "AgentUpdateBody") {}
class AgentProfileBodyDto extends createZodDto(ProfileBody, "AgentProfileBody") {}
class AgentAvatarUploadBodyDto extends createZodDto(AvatarUploadBody, "AgentAvatarUploadBody") {}
class AgentOwnerBodyDto extends createZodDto(OwnerBody, "AgentOwnerBody") {}

/**
 * Agent 定义（`/api/v1/orgs/:orgId/agents`）。读用 `agents.use`（访客与服务令牌可用），
 * 写用 `agents.create`（member 以上、HUMAN_ONLY），修改 / 删除的负责人或管理员判定在服务的组织行锁内完成。
 */
@Controller("api/v1/orgs/:orgId/agents")
export class AgentsController {
  constructor(
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentProfileService) private readonly profiles: AgentProfileService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
  ) {}

  @Post()
  @OrgAction("agents.create")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(AgentCreateBodyDto) body: z.infer<typeof CreateBody>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const p = requireUser(principal);
    return this.agents.create(
      org.orgId,
      p.account.id,
      {
        definition: body.definition,
        visibility: body.visibility,
        ...(body.memberIds !== undefined && { memberIds: body.memberIds }),
        ...(body.profile !== undefined && { profile: body.profile }),
      },
      patTokenId(p),
    );
  }

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ agents: AgentView[] }> {
    return { agents: await this.agents.listVisible(org.orgId, viewerOf(principal)) };
  }

  @Get(":agentId")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ agent: AgentView }> {
    return { agent: await this.agents.get(org.orgId, agentId, viewerOf(principal)) };
  }

  @Patch(":agentId")
  @OrgAction("agents.create")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentUpdateBodyDto) body: z.infer<typeof UpdateBody>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const p = requireUser(principal);
    return this.agents.update(org.orgId, agentId, p.account.id, body, patTokenId(p));
  }

  /** Display data only: no agent version. Same permission as `PATCH :agentId`. */
  @Patch(":agentId/profile")
  @OrgAction("agents.create")
  async updateProfile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentProfileBodyDto) body: z.infer<typeof ProfileBody>,
  ): Promise<{ profile: AgentProfile }> {
    const p = requireUser(principal);
    const { expectedUpdatedAt, ...patch } = body;
    return {
      profile: await this.profiles.update(
        org.orgId,
        agentId,
        p.account.id,
        patch,
        expectedUpdatedAt,
        patTokenId(p),
      ),
    };
  }

  /**
   * Registers an avatar image upload (presigned, like chat attachments and skill packages): the
   * browser uploads straight to the object store, then saves `{ kind: "upload", uploadId }` with
   * the profile PATCH, which finalizes it. 503 `storage.unavailable` without an object store.
   */
  @Post(":agentId/avatar/uploads")
  @OrgAction("agents.create")
  async createAvatarUpload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentAvatarUploadBodyDto) body: z.infer<typeof AvatarUploadBody>,
  ): Promise<CreatedAttachment> {
    const p = requireUser(principal);
    // the agent must exist and be visible to the caller (writing is checked when it is saved)
    await this.agents.get(org.orgId, agentId, viewerOf(p));
    return this.attachments.create(org.orgId, p.account.id, body, "agent-avatar");
  }

  /**
   * The avatar image: 302 to a short-lived presigned URL for an upload avatar, or to the stored
   * URL of an external avatar when it is https; 404 for presets, no avatar, or an agent the
   * reader cannot see.
   */
  @Get(":agentId/avatar")
  @OrgAction("agents.use")
  async avatar(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.agents.get(org.orgId, agentId, viewerOf(principal));
    const avatar = view.profile.avatar;
    let location: string | null = null;
    if (avatar?.kind === "upload") {
      location = await this.attachments.agentAvatarUrl(org.orgId, agentId, avatar.uploadId);
    } else if (avatar?.kind === "external") {
      try {
        if (new URL(avatar.url).protocol === "https:") location = avatar.url;
      } catch {
        // a malformed migrated URL: no image
      }
    }
    if (location === null) throw new ApiError("agent.not_found", "The agent has no avatar image");
    await reply
      .header(
        "cache-control",
        `private, max-age=${Math.floor(AGENT_AVATAR_DOWNLOAD_TTL_SECONDS / 5)}`,
      )
      .redirect(location, 302);
  }

  @Delete(":agentId")
  @HttpCode(204)
  @OrgAction("agents.create")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.agents.softDelete(org.orgId, agentId, p.account.id, patTokenId(p));
  }

  /** 重新指派负责人（admin，如负责人离职后）；清除 `needsReassignment`。 */
  @Post(":agentId/owner")
  @HttpCode(200)
  @OrgAction("agents.manage")
  async reassign(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentOwnerBodyDto) body: z.infer<typeof OwnerBody>,
  ): Promise<{ agent: AgentView }> {
    const p = requireUser(principal);
    return {
      agent: await this.agents.reassignOwner(
        org.orgId,
        agentId,
        body.accountId,
        p.account.id,
        patTokenId(p),
      ),
    };
  }

  @Get(":agentId/versions")
  @OrgAction("agents.use")
  async versions(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ versions: AgentVersionSummary[] }> {
    await this.agents.get(org.orgId, agentId, viewerOf(principal));
    return { versions: await this.agents.listVersions(agentId) };
  }
}
