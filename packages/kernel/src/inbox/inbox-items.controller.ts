import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { InboxItemActionBody, InboxItemActionParams, InboxItemParams } from "./inbox.schemas.js";
import { InboxItemActions } from "./inbox-item-actions.js";
import { InboxItemsService } from "./inbox-items.service.js";

class InboxItemParamsDto extends createZodDto(InboxItemParams, "InboxItemParams") {}
class InboxItemActionParamsDto extends createZodDto(
  InboxItemActionParams,
  "InboxItemActionParams",
) {}
class InboxItemActionBodyDto extends createZodDto(InboxItemActionBody, "InboxItemActionBody") {}

/**
 * A person's own personal inbox items (collaboration spec §4.9), user principals only; listed by
 * `GET /api/v1/orgs/:orgId/inbox` (`type: "item"`). Only the item's person reaches it: anyone
 * else, an org admin included, gets 404 `inbox.item_not_found`.
 * - `POST /api/v1/orgs/:orgId/inbox/items/:id/actions/:actionId` (`{ locale? }`) → `{ toast? }`:
 *   calls the plugin UI action the button names as the clicking person (the UI routes' access gate
 *   applies), then resolves the item (`ui.use`);
 * - `POST /api/v1/orgs/:orgId/inbox/items/:id/dismiss` → 204: resolves it without calling anything.
 */
@Controller("api/v1/orgs/:orgId/inbox/items")
export class InboxItemsController {
  constructor(
    @Inject(InboxItemsService) private readonly items: InboxItemsService,
    @Inject(InboxItemActions) private readonly actions: InboxItemActions,
  ) {}

  @Post(":id/actions/:actionId")
  @HttpCode(200)
  @OrgAction("ui.use")
  async act(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(InboxItemActionParamsDto) params: z.infer<typeof InboxItemActionParams>,
    @ZBody(InboxItemActionBodyDto) body: z.infer<typeof InboxItemActionBody>,
  ): Promise<{ toast?: { zh: string; en: string } }> {
    const p = requireUser(principal);
    return this.actions.click({
      orgId: org.orgId,
      accountId: p.account.id,
      role: org.role,
      itemId: params.id,
      actionId: params.actionId,
      locale: body.locale,
    });
  }

  @Post(":id/dismiss")
  @HttpCode(204)
  // the person's own item: any member, a guest included, reads and dismisses their own
  @OrgAction("org.read")
  async dismiss(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(InboxItemParamsDto) params: z.infer<typeof InboxItemParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.items.dismiss(org.orgId, p.account.id, params.id);
  }
}
