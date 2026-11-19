import { Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { CurrentPrincipal, type Principal, Public, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  HtmlDocumentService,
  type HtmlTokenResponse,
  htmlNotFound,
} from "./html-document.service.js";
import { HtmlTokens } from "./html-token.js";

/** `POST …/conversations/:id/files/:fileId/html-token`. */
export const HtmlTokenParams = z.object({
  id: z.string().min(1).max(100),
  fileId: z.string().min(1).max(100),
});

class HtmlTokenParamsDto extends createZodDto(HtmlTokenParams, "HtmlTokenParams") {}

/**
 * The HTML document (file sharing spec §4): the right panel mints a document token for one
 * version of the caller's HTML file (`agents.use`, the conversation's owner), then frames
 * `/api/v1/html/<token>`. The document route is public: the token is the authority, checked and
 * then re-checked live by {@link HtmlDocumentService.serve}.
 */
@Controller("api/v1")
export class HtmlDocumentController {
  constructor(
    @Inject(HtmlDocumentService) private readonly documents: HtmlDocumentService,
    @Inject(HtmlTokens) private readonly tokens: HtmlTokens,
  ) {}

  /** A document token: 200 `{ path, expiresIn }`. */
  @Post("orgs/:orgId/conversations/:id/files/:fileId/html-token")
  @HttpCode(200)
  @OrgAction("agents.use")
  async mint(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(HtmlTokenParamsDto) params: z.infer<typeof HtmlTokenParams>,
  ): Promise<HtmlTokenResponse> {
    const p = requireUser(principal);
    return this.documents.mint(org.orgId, params.id, p.account.id, params.fileId);
  }

  /**
   * The document a token names (`/api/v1/html/<token>`), under the sandbox CSP. A bad or expired
   * token, or a live check failing, is 404 `not_found` (one answer for every refusal). A wildcard
   * route: a token (up to 2048 characters) is longer than Fastify's `maxParamLength` (100) allows
   * a `:param`; a token never contains `/`, so anything with one fails verification.
   */
  @Public()
  @Get("html/*")
  async document(@Param("*") token: string, @Res() reply: FastifyReply): Promise<void> {
    const claims = this.tokens.verify(token);
    if (claims === null) throw htmlNotFound();
    await this.documents.serve(claims, reply);
  }
}
