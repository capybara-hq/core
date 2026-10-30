import { Controller, HttpCode, Inject, Param, Post } from "@nestjs/common";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { DirectorySync } from "./directory-sync.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";

/**
 * Manual directory sync (`/api/v1/orgs/:orgId/extensions/:extension/directory/sync`): it adds and
 * removes members, so only an admin and only a human may start it.
 */
@Controller("api/v1/orgs/:orgId/extensions/:extension/directory")
export class DirectorySyncController {
  constructor(@Inject(DirectorySync) private readonly directory: DirectorySync) {}

  @Post("sync")
  @HttpCode(202)
  @OrgAction("org.members.manage")
  async sync(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("extension") extension: string,
  ): Promise<{ jobId: string }> {
    const p = requireUser(principal);
    return this.directory.request(org.orgId, extension, p.account.id, patTokenId(p));
  }
}
