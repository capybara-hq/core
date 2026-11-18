import { Controller, Get, Inject, Patch, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { CreateBody } from "./conversations.controller.js";
import { ConversationsService } from "./conversations.service.js";
import {
  PermissionGetParams,
  PermissionPatchBody,
  PermissionPreviewQuery,
  PermissionSelectionSchema,
} from "./permission-profiles.schemas.js";
import { PermissionProfilesService } from "./permission-profiles.service.js";
export const FirstMessageBody = CreateBody.required({ message: true })
  .extend({ permission: PermissionSelectionSchema })
  .strict();
class PermissionParamsDto extends createZodDto(PermissionGetParams, "PermissionParams") {}
class PermissionPatchDto extends createZodDto(PermissionPatchBody, "PermissionPatch") {}
class PermissionPreviewDto extends createZodDto(PermissionPreviewQuery, "PermissionPreview") {}
class FirstMessageDto extends createZodDto(FirstMessageBody, "ConversationFirstMessage") {}
@Controller("api/v1/orgs/:orgId")
export class PermissionProfilesController {
  constructor(
    @Inject(PermissionProfilesService) private readonly permissions: PermissionProfilesService,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
  ) {}
  @Get("conversations/:id/permissions")
  @SessionOnly()
  @OrgAction("agents.use")
  get(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() p: Principal,
    @ZParam(PermissionParamsDto) { id }: z.infer<typeof PermissionGetParams>,
  ) {
    return this.permissions.get(org.orgId, id, requireUser(p).account.id);
  }
  @Patch("conversations/:id/permissions")
  @SessionOnly()
  @OrgAction("agents.use")
  set(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() p: Principal,
    @ZParam(PermissionParamsDto) { id }: z.infer<typeof PermissionGetParams>,
    @ZBody(PermissionPatchDto) body: z.infer<typeof PermissionPatchBody>,
  ) {
    return this.permissions.set(org.orgId, id, requireUser(p).account.id, body);
  }
  @Get("conversation-permission-preview")
  @SessionOnly()
  @OrgAction("agents.use")
  preview(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() p: Principal,
    @ZQuery(PermissionPreviewDto) q: z.infer<typeof PermissionPreviewQuery>,
  ) {
    return this.permissions.preview(org.orgId, requireUser(p).account.id, q.deviceId, q.project);
  }
  @Post("conversations/first-message")
  @SessionOnly()
  @OrgAction("agents.use")
  async first(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() p: Principal,
    @ZBody(FirstMessageDto) body: z.infer<typeof FirstMessageBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { permission, agentId, message, deviceId, project } = body;
    const out = await this.conversations.createWithMessage(
      org.orgId,
      requireUser(p).account.id,
      agentId,
      {
        text: message.text,
        clientMessageId: message.clientMessageId,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.files !== undefined ? { files: message.files } : {}),
        ...(message.model !== undefined ? { model: message.model } : {}),
        ...(message.effort !== undefined ? { effort: message.effort } : {}),
        ...(message.skill !== undefined ? { skill: message.skill } : {}),
        ...(message.timeZone !== undefined ? { timeZone: message.timeZone } : {}),
        ...(message.locale !== undefined ? { locale: message.locale } : {}),
      },
      {
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(project !== undefined ? { project } : {}),
      },
      { source: "web", initialPermission: permission },
    );
    reply.status(out.created ? 201 : 200);
    return { conversation: out.conversation, event: out.event, events: out.events };
  }
}
