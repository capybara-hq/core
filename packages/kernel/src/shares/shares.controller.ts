import { Controller, Delete, Get, Header, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  CreateShareBody,
  ListSharesQuery,
  ShareFileParams,
  ShareIdParams,
} from "./shares.schemas.js";
import { type SharePolicy, SharesService, type ShareView } from "./shares.service.js";

class ShareFileParamsDto extends createZodDto(ShareFileParams, "ShareFileParams") {}
class CreateShareBodyDto extends createZodDto(CreateShareBody, "CreateShareBody") {}
class ShareIdParamsDto extends createZodDto(ShareIdParams, "ShareIdParams") {}
class ListSharesQueryDto extends createZodDto(ListSharesQuery, "ListSharesQuery") {}

/**
 * Shares of conversation files (file sharing spec §2): `agents.use`, a person only (a service
 * token is refused by `requireUser`). Creating and listing a file's shares need the conversation's
 * owner (`ConversationAccess.isAccessible`, else `conversation.not_found`); refreshing needs the
 * creator, revoking the creator or an org admin (else `share.not_found`).
 */
@Controller("api/v1/orgs/:orgId")
export class SharesController {
  constructor(@Inject(SharesService) private readonly shares: SharesService) {}

  /** Shares one file of the caller's conversation as a snapshot: 201 `{ share }`. */
  @Post("conversations/:id/files/:fileId/shares")
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ShareFileParamsDto) params: z.infer<typeof ShareFileParams>,
    @ZBody(CreateShareBodyDto) body: z.infer<typeof CreateShareBody>,
  ): Promise<{ share: ShareView }> {
    const p = requireUser(principal);
    return {
      share: await this.shares.create(org.orgId, p.account.id, params.id, params.fileId, body, {
        tokenId: patTokenId(p),
      }),
    };
  }

  /** The live and recent shares of one file, with what the share dialog may offer. */
  @Get("conversations/:id/files/:fileId/shares")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async forFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ShareFileParamsDto) params: z.infer<typeof ShareFileParams>,
  ): Promise<{ shares: ShareView[]; policy: SharePolicy }> {
    const p = requireUser(principal);
    return this.shares.forFile(org.orgId, p.account.id, params.id, params.fileId);
  }

  /** "Update to latest": the newest available version as the next generation (creator only). */
  @Post("shares/:shareId/refresh")
  @HttpCode(200)
  @OrgAction("agents.use")
  async refresh(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ShareIdParamsDto) params: z.infer<typeof ShareIdParams>,
  ): Promise<{ share: ShareView }> {
    const p = requireUser(principal);
    return {
      share: await this.shares.refresh(org.orgId, p.account.id, params.shareId, {
        tokenId: patTokenId(p),
      }),
    };
  }

  /** Revokes a share (creator or org admin): 204, also when it was already revoked. */
  @Delete("shares/:shareId")
  @HttpCode(204)
  @OrgAction("agents.use")
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ShareIdParamsDto) params: z.infer<typeof ShareIdParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.shares.revoke(org.orgId, p.account.id, params.shareId, { tokenId: patTokenId(p) });
  }

  /** The caller's shares (`scope=mine`, default) or the org's (`scope=all`, org admins). */
  @Get("shares")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(ListSharesQueryDto) q: z.infer<typeof ListSharesQuery>,
  ): Promise<{ shares: ShareView[] }> {
    const p = requireUser(principal);
    return this.shares.list(org.orgId, p.account.id, q.scope);
  }
}
