import { Controller, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { DIRECTORY_SYNC } from "../http/tokens.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import type { DirectorySync } from "./directory-sync.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";

/** 通讯录手动同步（`/api/v1/orgs/:orgId/plugins/:plugin/directory/sync`）：会增删成员，admin 且只能由人发起。 */
@Controller("api/v1/orgs/:orgId/plugins/:plugin/directory")
export class DirectorySyncController {
  constructor(@Inject(DIRECTORY_SYNC) private readonly directory: DirectorySync) {}

  @Post("sync")
  @HttpCode(202)
  @OrgAction("org.members.manage")
  async sync(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("plugin") plugin: string,
  ): Promise<{ jobId: string }> {
    const p = requireUser(principal);
    return this.directory.request(org.orgId, plugin, p.account.id, patTokenId(p));
  }
}
