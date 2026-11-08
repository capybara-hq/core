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
  AgentCreateBody,
  AgentFromTemplateBody,
  AgentFromTemplatePreviewBody,
  AgentUpdateBody,
} from "./agents.schemas.js";
import {
  AgentsService,
  type AgentVersionSummary,
  type AgentView,
  type AgentWarning,
} from "./agents.service.js";
import { AgentsFromTemplate, type TemplatePreview } from "./from-template.service.js";
import { type AgentProfile, ProfileInputSchema } from "./profile.js";

const OwnerBody = z.object({ accountId: z.string().min(1).max(100) }).strict();

// the description is part of the agent's definition (run context spec §3.5): saved with the agent
const ProfileBody = ProfileInputSchema.omit({ description: true })
  .extend({
    /** The `profile.updatedAt` the client read; a different one → 409 `agent.profile_conflict`. */
    expectedUpdatedAt: z.string().min(1).max(40),
  })
  .strict();
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
/** 服务令牌没有账号：以 null 作为 viewer，只看到 visibility='org' 的 agent。 */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

class AgentCreateBodyDto extends createZodDto(AgentCreateBody, "AgentCreateBody") {}
class AgentUpdateBodyDto extends createZodDto(AgentUpdateBody, "AgentUpdateBody") {}
class AgentProfileBodyDto extends createZodDto(ProfileBody, "AgentProfileBody") {}
class AgentAvatarUploadBodyDto extends createZodDto(AvatarUploadBody, "AgentAvatarUploadBody") {}
class AgentOwnerBodyDto extends createZodDto(OwnerBody, "AgentOwnerBody") {}
class AgentFromTemplatePreviewBodyDto extends createZodDto(
  AgentFromTemplatePreviewBody,
  "AgentFromTemplatePreviewBody",
) {}
class AgentFromTemplateBodyDto extends createZodDto(
  AgentFromTemplateBody,
  "AgentFromTemplateBody",
) {}

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
    @Inject(AgentsFromTemplate) private readonly fromTemplate: AgentsFromTemplate,
  ) {}

  /** A response's view with its provenance link (`createdFrom.available`, ruling P4-8). */
  private async linked(orgId: string, view: AgentView): Promise<AgentView> {
    return (await this.agents.withTemplateLinks(orgId, [view]))[0] as AgentView;
  }

  /**
   * What creating an agent from a template would carry over (rulings P4-3, P4-5): the items
   * (carried / pending / unavailable, with reasons), the model the dialog preselects (P4-4), the
   * template fields with no place in the agent, and the `previewHash` the create must send. A
   * template not usable in the org → 404 `component.not_found`.
   */
  @Post("from-template/preview")
  @HttpCode(200)
  @OrgAction("agents.create")
  async previewFromTemplate(
    @CurrentOrg() org: OrgContext,
    @ZBody(AgentFromTemplatePreviewBodyDto) body: z.infer<typeof AgentFromTemplatePreviewBody>,
  ): Promise<TemplatePreview> {
    return this.fromTemplate.preview(org.orgId, body.templateId);
  }

  /**
   * Creates an agent from a template (ruling P4-3): private by default; another visibility without
   * `agents.manage` → 403 `agent.visibility_forbidden`; a plan that no longer matches the preview →
   * 409 `agent.template_preview_stale`. The agent records its provenance (P4-8) and carries the
   * template's missing connectors as `pendingConnectors` (P4-6).
   */
  @Post("from-template")
  @OrgAction("agents.create")
  async createFromTemplate(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(AgentFromTemplateBodyDto) body: z.infer<typeof AgentFromTemplateBody>,
  ): Promise<{ agent: AgentView }> {
    const p = requireUser(principal);
    const { agent } = await this.fromTemplate.create(
      org.orgId,
      p.account.id,
      {
        templateId: body.templateId,
        name: body.name,
        previewHash: body.previewHash,
        ...(body.visibility !== undefined && { visibility: body.visibility }),
        ...(body.members !== undefined && { members: body.members }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.avatar !== undefined && { avatar: body.avatar }),
      },
      patTokenId(p),
    );
    return { agent: await this.linked(org.orgId, agent) };
  }

  @Post()
  @OrgAction("agents.create")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(AgentCreateBodyDto) body: z.infer<typeof AgentCreateBody>,
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
    const agents = await this.agents.listVisible(org.orgId, viewerOf(principal));
    return { agents: await this.agents.withTemplateLinks(org.orgId, agents) };
  }

  @Get(":agentId")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ agent: AgentView }> {
    return {
      agent: await this.linked(
        org.orgId,
        await this.agents.get(org.orgId, agentId, viewerOf(principal)),
      ),
    };
  }

  @Patch(":agentId")
  @OrgAction("agents.create")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @ZBody(AgentUpdateBodyDto) body: z.infer<typeof AgentUpdateBody>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const p = requireUser(principal);
    const r = await this.agents.update(org.orgId, agentId, p.account.id, body, patTokenId(p));
    return { ...r, agent: await this.linked(org.orgId, r.agent) };
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
    const agent = await this.agents.reassignOwner(
      org.orgId,
      agentId,
      body.accountId,
      p.account.id,
      patTokenId(p),
    );
    return { agent: await this.linked(org.orgId, agent) };
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
