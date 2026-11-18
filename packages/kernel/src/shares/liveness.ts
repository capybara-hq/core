import type { ShareEmbedClaims } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import { accessibleTo } from "../conversations/access.js";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { parseOrgSettings } from "../orgs/settings.service.js";
import { UUID_RE } from "../ui/registry.js";
import { effectiveExternalSharing, readExternalSharing } from "./settings.js";
import { SHARE_CODE_RE } from "./share-code.js";

/** A share that may be opened now ({@link ShareLiveness}). */
export interface LiveShare {
  id: string;
  orgId: string;
  code: string;
  audience: "internal" | "external";
  conversationId: string;
  createdBy: string;
  createdByName: string;
  name: string;
  contentType: string;
  size: number;
  /** The current generation's snapshot, relative to the org's kernel prefix. */
  objectKey: string;
  generation: number;
  expiresAt: Date | null;
}

/**
 * Whether its creator could still open the conversation the share was taken from: the conversation
 * predicate of `ConversationAccess.isAccessible` with the share's `created_by` as the viewer, over
 * the conversation of the share's org (so a row can never reach another org's conversation).
 */
export const creatorStillHasAccess = (eb: ExpressionBuilder<KernelDatabase, "file_shares">) =>
  eb.exists(
    eb
      .selectFrom("conversations")
      .select(sql`1`.as("one"))
      .whereRef("conversations.id", "=", "file_shares.conversation_id")
      .whereRef("conversations.org_id", "=", "file_shares.org_id")
      .where((c) =>
        accessibleTo(sql.ref<string>("file_shares.created_by"))(
          c as unknown as ExpressionBuilder<KernelDatabase, "conversations">,
        ),
      ),
  );

/**
 * The live check of a share (file sharing spec §1), the one the open routes, the HTML document
 * token and share-scoped embed tokens use: not revoked, not expired, its snapshot not freed, the
 * org not deleted, its creator passes `ConversationAccess.isAccessible`'s predicates (active
 * account, still a member, the conversation and its tree root not deleted, the agent not deleted
 * and still visible to the creator), and for an external share the effective external sharing
 * switch allows it now. One query (plus the platform switch for an external share, read live), no
 * cache: a cause going away (the switch back on) makes a share not expired live again.
 */
@Injectable()
export class ShareLiveness {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /** The live share with this code, or null (unknown, revoked, expired or not live). */
  async byCode(code: string): Promise<LiveShare | null> {
    if (!SHARE_CODE_RE.test(code)) return null;
    return this.find({ code });
  }

  /** The live share with this id (and generation, when given), or null. */
  async byId(shareId: string, generation?: number): Promise<LiveShare | null> {
    if (!UUID_RE.test(shareId)) return null;
    return this.find({ id: shareId, ...(generation !== undefined && { generation }) });
  }

  /**
   * Whether a share-scoped embed token (file sharing spec §7) still holds, checked on every use:
   * the share is live at the token's generation, in the token's org, and `plugin` is enabled in
   * that org (`enabled.ts`: its switch, or always on). One query (plus the platform switch for an
   * external share).
   */
  async embedLive(plugin: string, c: ShareEmbedClaims): Promise<boolean> {
    if (!UUID_RE.test(c.shareId) || !UUID_RE.test(c.orgId)) return false;
    const share = await this.find({
      id: c.shareId,
      generation: c.generation,
      orgId: c.orgId,
      plugin,
    });
    return share !== null;
  }

  private async find(by: {
    code?: string;
    id?: string;
    generation?: number;
    /** With `plugin`: the share is in this org and the extension is enabled there. */
    orgId?: string;
    plugin?: string;
  }): Promise<LiveShare | null> {
    let q = this.db
      .selectFrom("file_shares")
      .innerJoin("orgs", "orgs.id", "file_shares.org_id")
      .innerJoin("accounts as creator", "creator.id", "file_shares.created_by")
      .select([
        "file_shares.id",
        "file_shares.org_id",
        "file_shares.code",
        "file_shares.audience",
        "file_shares.conversation_id",
        "file_shares.created_by",
        "creator.display_name",
        "file_shares.name",
        "file_shares.content_type",
        "file_shares.size",
        "file_shares.object_key",
        "file_shares.generation",
        "file_shares.expires_at",
        "orgs.settings",
      ])
      .where("orgs.deleted_at", "is", null)
      .where("file_shares.revoked_at", "is", null)
      .where("file_shares.object_key", "is not", null)
      .where((eb) =>
        eb.or([
          eb("file_shares.expires_at", "is", null),
          eb("file_shares.expires_at", ">", sql<Date>`now()`),
        ]),
      )
      .where((eb) =>
        creatorStillHasAccess(eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">),
      );
    if (by.code !== undefined) q = q.where("file_shares.code", "=", by.code);
    if (by.id !== undefined) q = q.where("file_shares.id", "=", by.id);
    if (by.generation !== undefined) q = q.where("file_shares.generation", "=", by.generation);
    if (by.orgId !== undefined) q = q.where("file_shares.org_id", "=", by.orgId);
    const { orgId, plugin } = by;
    if (orgId !== undefined && plugin !== undefined) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom(enabledExtensionsQuery(this.db.db, orgId).as("en"))
            .select("en.plugin")
            .where("en.plugin", "=", plugin),
        ),
      );
    }
    const row = await q.executeTakeFirst();
    if (!row || row.object_key === null) return null;
    if (row.audience === "external") {
      const platform = await readExternalSharing(this.db.db, this.config, this.log);
      const org = parseOrgSettings(row.settings).externalSharing;
      if (effectiveExternalSharing(platform.value, org) !== "allowed") return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      code: row.code,
      audience: row.audience,
      conversationId: row.conversation_id,
      createdBy: row.created_by,
      createdByName: row.display_name,
      name: row.name,
      contentType: row.content_type,
      size: Number(row.size),
      objectKey: row.object_key,
      generation: row.generation,
      expiresAt: row.expires_at,
    };
  }
}

/** The one {@link ShareLiveness} (database and config only): the open routes and tokens use it. */
@Module({ providers: [ShareLiveness], exports: [ShareLiveness] })
export class ShareLivenessModule {}
