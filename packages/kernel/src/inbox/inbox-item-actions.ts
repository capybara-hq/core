import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { LockService } from "../infra/lock/lock.service.js";
import type { OrgRole } from "../orgs/roles.js";
import { UiViews } from "../ui/views.js";
import { InboxItemsService } from "./inbox-items.service.js";

/**
 * A person clicks an action of their own personal inbox item (collaboration spec §4.9,
 * `POST inbox/items/:id/actions/:actionId`): the kernel calls the plugin's UI action the button
 * names through {@link UiViews.act} (its access gate applies: the contribution's slot and role, the
 * plugin enabled in the org, a valid effective config) with the clicking person as the account and
 * role, then resolves the item. The click is serialized per item under a lock (a second click while
 * the first runs is refused `lock.acquire_failed`), and the item is read again under it, so one
 * item calls its plugin at most once; an action that fails leaves the item open.
 */
@Injectable()
export class InboxItemActions {
  constructor(
    @Inject(InboxItemsService)
    private readonly items: Pick<InboxItemsService, "openOf" | "close">,
    @Inject(UiViews) private readonly views: Pick<UiViews, "act">,
    @Inject(LockService) private readonly locks: Pick<LockService, "run">,
  ) {}

  /**
   * Runs action `actionId` of item `itemId` for `accountId` (role `role` in `orgId`). Not the
   * caller's open unexpired item -> `inbox.item_not_found`; no such action ->
   * `inbox.action_not_found`. Returns the action's toast, if any.
   */
  async click(input: {
    orgId: string;
    accountId: string;
    role: OrgRole;
    itemId: string;
    actionId: string;
    locale: "zh" | "en";
  }): Promise<{ toast?: { zh: string; en: string } }> {
    const { orgId, accountId, itemId } = input;
    // checked before the lock too: another person's id never reaches the lock
    await this.items.openOf(orgId, accountId, itemId);
    return this.locks.run(`inbox-item:${itemId}`, { ttlMs: 60_000 }, async () => {
      const item = await this.items.openOf(orgId, accountId, itemId);
      const action = item.actions.find((a) => a.id === input.actionId);
      if (action === undefined || item.plugin === null)
        throw new ApiError("inbox.action_not_found", "Inbox item action not found");
      const r = await this.views.act(
        {
          orgId,
          accountId,
          role: input.role,
          plugin: item.plugin,
          id: action.uiAction.contribution,
          locale: input.locale,
        },
        {
          actionId: action.uiAction.actionId,
          ...(action.uiAction.payload !== undefined && { payload: action.uiAction.payload }),
        },
      );
      await this.items.close(orgId, itemId);
      return "toast" in r && r.toast !== undefined ? { toast: r.toast } : {};
    });
  }
}
