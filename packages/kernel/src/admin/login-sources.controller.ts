import { Controller, Get, Inject, Put } from "@nestjs/common";
import type { z } from "zod";
import { LoginSourcesService, type LoginSourceView } from "../identity/login-sources.js";
import { CurrentPrincipal, type Principal, SuperAdmin } from "../identity/principal.js";
import { writeActorOf } from "../identity/write-actor.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import {
  LoginSourceBody,
  LoginSourceParams,
  LoginSourcesOrderBody,
} from "./login-sources.schemas.js";

class LoginSourceParamsDto extends createZodDto(LoginSourceParams, "LoginSourceParams") {}
class LoginSourceBodyDto extends createZodDto(LoginSourceBody, "LoginSourceBody") {}
class LoginSourcesOrderBodyDto extends createZodDto(
  LoginSourcesOrderBody,
  "LoginSourcesOrderBody",
) {}

/**
 * The login sources (`/api/v1/admin/login-sources`, login extensions spec §3): which
 * `identity-source@1` extensions the login page offers, in which order, what happens to an
 * unlinked external account and the tenants trusted for email merge. Super admins only; every
 * write is audited `login_sources.updated` and the login page follows at once.
 */
@Controller("api/v1/admin/login-sources")
@SuperAdmin()
export class AdminLoginSourcesController {
  constructor(@Inject(LoginSourcesService) private readonly sources: LoginSourcesService) {}

  /** Every loaded identity source and every stored entry: enabled first in order, then by name. */
  @Get()
  async list(): Promise<{ items: LoginSourceView[] }> {
    return { items: await this.sources.overview() };
  }

  /**
   * Sets the login page order (declared before `:plugin`; the router also prefers the static
   * segment): every enabled entry exactly once, else 400 `validation_failed`.
   */
  @Put("order")
  async reorder(
    @CurrentPrincipal() principal: Principal,
    @ZBody(LoginSourcesOrderBodyDto) body: z.infer<typeof LoginSourcesOrderBody>,
  ): Promise<{ items: LoginSourceView[] }> {
    const actor = writeActorOf(principal);
    await this.sources.reorder(body.plugins, actor.accountId, viaToken(actor.tokenId));
    return { items: await this.sources.overview() };
  }

  /**
   * Changes one entry (partial). 404 `login_sources.unknown_plugin`, 400
   * `login_sources.invalid_tenant`, 409 `login_sources.needs_config`.
   */
  @Put(":plugin")
  async update(
    @CurrentPrincipal() principal: Principal,
    @ZParam(LoginSourceParamsDto) { plugin }: z.infer<typeof LoginSourceParams>,
    @ZBody(LoginSourceBodyDto) body: z.infer<typeof LoginSourceBody>,
  ): Promise<LoginSourceView> {
    const actor = writeActorOf(principal);
    await this.sources.update(plugin, body, actor.accountId, viaToken(actor.tokenId));
    return this.sources.view(plugin);
  }
}

const viaToken = (tokenId: string | undefined) =>
  tokenId === undefined ? {} : { actorTokenId: tokenId };
