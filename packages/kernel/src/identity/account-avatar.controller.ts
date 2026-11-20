import type { Logger } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { avatarColumns, ownAvatar, safeSsoUrl } from "./account-avatar.js";
import { AccountAvatarsService } from "./account-avatars.service.js";
import {
  AllowPendingPasswordChange,
  CurrentPrincipal,
  type Principal,
  requireUser,
} from "./principal.js";

/** How long a browser may reuse the redirect (the presigned URL itself lives 300 s). */
const AVATAR_CACHE_CONTROL = "private, max-age=60";
/** A refusal is never cached: the image may appear (or access be granted) at any moment. */
const NOT_FOUND_CACHE_CONTROL = "private, no-store";

/**
 * The single refusal of the avatar route: a reader who may not see the person, an unknown
 * account and a person without an image all get exactly this, so existence never leaks.
 */
const notFound = () => new ApiError("account.not_found", "Account not found");

/**
 * A person's avatar image (account profile spec §5): readable by the account itself, a super
 * admin, or anyone who shares an org with the person (any role, guests included; deleted orgs do
 * not count). Default auth: a session or a personal token; service tokens and embed tokens never.
 * An account that must change its password first still reads its own image (the shell draws it),
 * and only its own.
 */
@Controller("api/v1/accounts")
export class AccountAvatarController {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(AccountAvatarsService)
    private readonly avatars: Pick<AccountAvatarsService, "objectUrl">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  /**
   * 302 to a short-lived presigned URL of the person's own upload; else (no upload, its object
   * gone, or no object store) 302 to their SSO `https:` avatar; else 404. The `v` query parameter
   * only busts browser caches and is ignored. An object store failure never fails the route: it
   * falls back like a missing object, with a warning.
   */
  @Get(":accountId/avatar")
  @AllowPendingPasswordChange()
  async avatar(
    @CurrentPrincipal() principal: Principal,
    @Param("accountId") accountId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const reader = requireUser(principal).account;
    const refuse = () => {
      reply.header("cache-control", NOT_FOUND_CACHE_CONTROL);
      return notFound();
    };
    if (reader.mustChangePassword && accountId !== reader.id) throw refuse();
    const row = await this.db
      .selectFrom("accounts")
      .select((eb) => avatarColumns(eb, "accounts", "target"))
      .where("accounts.id", "=", accountId)
      .$if(!reader.isSuperAdmin, (q) =>
        q.where((eb) =>
          eb.or([
            eb("accounts.id", "=", reader.id),
            eb.exists(
              eb
                .selectFrom("memberships as target_m")
                .innerJoin("memberships as reader_m", "reader_m.org_id", "target_m.org_id")
                .innerJoin("orgs as shared_org", "shared_org.id", "target_m.org_id")
                .select(sql<number>`1`.as("one"))
                .where("target_m.account_id", "=", eb.ref("accounts.id"))
                .where("reader_m.account_id", "=", reader.id)
                .where("shared_org.deleted_at", "is", null),
            ),
          ]),
        ),
      )
      .executeTakeFirst();
    if (!row) throw refuse();

    let location: string | null = null;
    const own = ownAvatar(row.target_avatar);
    if (own) location = await this.uploadUrl(accountId, own.uploadId);
    location ??= safeSsoUrl(row.target_sso_avatar_url);
    if (location === null) throw refuse();
    await reply.header("cache-control", AVATAR_CACHE_CONTROL).redirect(location, 302);
  }

  /**
   * The presigned URL of the bound upload; null when it is gone, there is no object store, or the
   * store failed (logged).
   */
  private async uploadUrl(accountId: string, uploadId: string): Promise<string | null> {
    try {
      return await this.avatars.objectUrl(accountId, uploadId);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "storage.unavailable")) {
        this.log.warn("account avatar: object store failed, falling back", {
          accountId,
          uploadId,
          err,
        });
      }
      return null;
    }
  }
}
