import { Body, Controller, Get, Header, Inject, Param, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { FILE_PREVIEWERS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { OrgPreviewerItem, PreviewerItem, PreviewerRegistry } from "./previewers.js";

const Id = z.string().min(1).max(100);
const PreviewQuery = z.object({ locale: z.enum(["zh", "en"]).default("en") });
const OrderBody = z.object({
  items: z.array(z.object({ plugin: Id, id: Id, disabled: z.boolean().default(false) })).max(500),
});

/**
 * `file-preview@1` (UI refresh B Task 11):
 * - `GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/previewers` → `{ previewers }`: the
 *   extension previewers that take this file version, in the org's order (viewer must read the
 *   conversation, otherwise 404);
 * - `GET .../files/:fileId/previews/:plugin/:previewerId?locale=` → `{ view }`: a view previewer's
 *   render (10 s → 504 `ui.timeout`, throws → 502 `ui.render_failed`, invalid → 502
 *   `ui.invalid_view`); an embed previewer gets its token from the ui embed-token route with
 *   `{ conversationId, fileId }` and the file over the message bridge;
 * - `GET / PUT /api/v1/orgs/:orgId/file-previewers` (`org.extensions.manage`) → `{ items }`: the
 *   org's order; PUT lists `{ plugin, id, disabled }` first-to-last, the rest follow.
 */
@Controller("api/v1/orgs/:orgId")
export class FilePreviewersController {
  constructor(@Inject(FILE_PREVIEWERS) private readonly previewers: PreviewerRegistry) {}

  @Get("conversations/:id/files/:fileId/previewers")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async forFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
  ): Promise<{ previewers: PreviewerItem[] }> {
    const p = requireUser(principal);
    return { previewers: await this.previewers.forFile(org.orgId, id, p.account.id, fileId) };
  }

  @Get("conversations/:id/files/:fileId/previews/:plugin/:previewerId")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
    @Param("plugin", new ZodPipe(Id)) plugin: string,
    @Param("previewerId", new ZodPipe(Id)) previewerId: string,
    @Query(new ZodPipe(PreviewQuery)) q: z.infer<typeof PreviewQuery>,
  ) {
    const p = requireUser(principal);
    const view = await this.previewers.render({
      orgId: org.orgId,
      accountId: p.account.id,
      conversationId: id,
      fileId,
      plugin,
      id: previewerId,
      locale: q.locale,
    });
    return { view };
  }

  @Get("file-previewers")
  @OrgAction("org.extensions.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ items: OrgPreviewerItem[] }> {
    return { items: await this.previewers.list(org.orgId) };
  }

  @Put("file-previewers")
  @OrgAction("org.extensions.manage")
  async put(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(OrderBody)) body: z.infer<typeof OrderBody>,
  ): Promise<{ items: OrgPreviewerItem[] }> {
    const actor =
      principal.kind === "service"
        ? { tokenId: principal.tokenId }
        : {
            accountId: principal.account.id,
            ...(principal.via === "pat" && { tokenId: principal.tokenId }),
          };
    return { items: await this.previewers.put(org.orgId, body.items, actor) };
  }
}
