import { randomUUID } from "node:crypto";
import {
  INBOX_LIMITS,
  InboxError,
  type InboxPost,
  type LocalizedName,
  validateInboxPost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import type { StoredInboxAction } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PushOwed, PushOwedModule } from "../push/push-owed.js";
import { pluginDisplayNames } from "../tools/display-names.js";
import { INBOX_ITEMS_BACKEND } from "./token.js";

/** Who posts an item: the kernel, or an extension (by plugin name). */
export type InboxSource = { kind: "kernel" } | { kind: "plugin"; plugin: string };

/** The most open personal items one inbox read returns. */
export const INBOX_ITEMS_LIST_MAX = 100;

/**
 * A personal inbox item as its person sees it (collaboration spec §4.9): never the UI actions its
 * buttons call (those stay in the kernel), only each button's id, label and style.
 */
export interface PersonalInboxItemView {
  id: string;
  source: "kernel" | "plugin";
  /** The posting extension; null for a kernel item. */
  plugin: string | null;
  /** The plugin's display name (its name in both languages when it has none); null for the kernel. */
  pluginName: LocalizedName | null;
  kind: string;
  title: string;
  body: string;
  /** An in-app path; a plugin item's is one of the plugin's pages (`/p/<plugin>/…`). */
  link: string | null;
  actions: { id: string; label: LocalizedName; style?: "primary" | "danger" }[];
  expiresAt: string;
  createdAt: string;
}

/** An open item of the caller, with its stored actions (for the click). */
export interface OpenInboxItem {
  id: string;
  orgId: string;
  accountId: string;
  plugin: string | null;
  actions: StoredInboxAction[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message: string): InboxError => new InboxError("invalid_item", message);

/**
 * A kernel item's link: an in-app path (`/…`, never `//`), no backslash or control character, at
 * most {@link INBOX_LIMITS}.linkChars characters.
 */
const kernelLinkOk = (link: string): boolean =>
  link.startsWith("/") &&
  !link.startsWith("//") &&
  link.length <= INBOX_LIMITS.linkChars &&
  !/[\\\p{Cc}]/u.test(link);

const notFound = (): ApiError => new ApiError("inbox.item_not_found", "Inbox item not found");

/**
 * Personal inbox items (`inbox_items`, collaboration spec §4.9): an item for one person in one
 * org, posted by the kernel or by an extension (`ctx.inbox.post`, which calls {@link post} with the
 * extension's own name: an extension cannot post as another plugin). Only the item's person lists
 * it, clicks its actions ({@link InboxItemActions}) or dismisses it; everyone else, the org's
 * admins included, gets `inbox.item_not_found`. An item past `expires_at` is gone. Every read and
 * write filters by the item's org.
 */
@Injectable()
export class InboxItemsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PushOwed) private readonly push: Pick<PushOwed, "oweInboxItem">,
  ) {}

  /**
   * Posts `p` for `source` and owes its push fanout in the same transaction. The SDK's
   * `validateInboxPost` checks the fields (a plugin item links only to `/p/<plugin>/…`; a kernel
   * item to any in-app path and carries no actions); the account must be an active member of the
   * org, and a plugin must be enabled there. With `dedupeKey`, an open unexpired item of the same
   * (org, account, source, plugin, key) is returned instead (no new push); an expired one is
   * closed and replaced. The caller runs it in the item's org scope.
   *
   * Throws `InboxError`: `invalid_item` (a missing or malformed field, not an active member),
   * `org_disabled` (the plugin is not enabled in the org).
   */
  @Transactional()
  async post(source: InboxSource, p: InboxPost): Promise<{ itemId: string }> {
    if (typeof p !== "object" || p === null) throw invalid("the item must be an object");
    const plugin = source.kind === "plugin" ? source.plugin : null;
    const errs = validateInboxPost(p, plugin ?? "").filter(
      (e) => plugin !== null || e !== "link_invalid",
    );
    if (plugin === null) {
      if (p.link !== undefined && (typeof p.link !== "string" || !kernelLinkOk(p.link)))
        errs.push("link_invalid");
      if (p.actions !== undefined && p.actions.length > 0) errs.push("kernel_item_actions");
    }
    if (errs.length > 0) throw invalid(`invalid inbox item: ${errs.join(", ")}`);
    const db = this.kdb.db;
    if (plugin !== null && !(await isExtensionEnabled(db, p.orgId, plugin)))
      throw new InboxError("org_disabled", `${plugin} is not enabled in org ${p.orgId}`);
    const member = await db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("accounts.id")
      .where("memberships.org_id", "=", p.orgId)
      .where("memberships.account_id", "=", p.accountId)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    if (member === undefined)
      throw invalid(`account ${p.accountId} is not an active member of org ${p.orgId}`);
    const dedupe = p.dedupeKey ?? null;
    if (dedupe !== null) {
      // an expired item with the key leaves the index's way: it is closed, a new one replaces it
      await this.sameKey(p.orgId, p.accountId, source, dedupe)
        .where("expires_at", "<=", sql<Date>`now()`)
        .execute();
    }
    const actions: StoredInboxAction[] = (p.actions ?? []).map((a) => ({
      id: a.id,
      label: { zh: a.label.zh, en: a.label.en },
      ...(a.style !== undefined && { style: a.style }),
      uiAction: {
        contribution: a.uiAction.contribution,
        actionId: a.uiAction.actionId,
        ...(a.uiAction.payload !== undefined && { payload: a.uiAction.payload }),
      },
    }));
    const seconds = p.expiresInSeconds ?? INBOX_LIMITS.defaultExpirySeconds;
    const id = randomUUID();
    const inserted = await db
      .insertInto("inbox_items")
      .values({
        id,
        org_id: p.orgId,
        account_id: p.accountId,
        source: source.kind,
        plugin,
        kind: p.kind,
        title: p.title,
        body: p.body ?? "",
        link: p.link ?? null,
        actions: JSON.stringify(actions),
        dedupe_key: dedupe,
        expires_at: sql<Date>`now() + make_interval(secs => ${seconds})`,
      })
      // only the partial dedupe index can conflict (the id is new)
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted === undefined && dedupe !== null) {
      const existing = await db
        .selectFrom("inbox_items")
        .select("id")
        .where("org_id", "=", p.orgId)
        .where("account_id", "=", p.accountId)
        .where("source", "=", source.kind)
        .where(sql<boolean>`coalesce(plugin, '') = ${plugin ?? ""}`)
        .where("dedupe_key", "=", dedupe)
        .where("state", "=", "open")
        .executeTakeFirstOrThrow();
      return { itemId: existing.id };
    }
    if (inserted === undefined) throw new Error("inbox item insert conflicted without a key");
    await this.push.oweInboxItem(id, p.orgId);
    return { itemId: id };
  }

  /** The open items of (org, account, source, plugin) with `dedupe`, closed as `expired`. */
  private sameKey(orgId: string, accountId: string, source: InboxSource, dedupe: string) {
    const plugin = source.kind === "plugin" ? source.plugin : "";
    return this.kdb.db
      .updateTable("inbox_items")
      .set({ state: "expired" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("source", "=", source.kind)
      .where(sql<boolean>`coalesce(plugin, '') = ${plugin}`)
      .where("dedupe_key", "=", dedupe)
      .where("state", "=", "open");
  }

  /**
   * An extension resolves an open item it posted (`ctx.inbox.resolve`); an item of this plugin
   * already resolved or expired is left as it is. Another plugin's item, a kernel item or an
   * unknown id throws `InboxError("not_found")`. The caller runs it in the org's scope.
   */
  async resolveForPlugin(plugin: string, orgId: string, itemId: string): Promise<void> {
    if (typeof orgId !== "string" || typeof itemId !== "string" || !UUID_RE.test(itemId))
      throw new InboxError("not_found", "inbox item not found");
    const row = await this.kdb.db
      .selectFrom("inbox_items")
      .select("id")
      .where("org_id", "=", orgId)
      .where("id", "=", itemId)
      .where("source", "=", "plugin")
      .where("plugin", "=", plugin)
      .executeTakeFirst();
    if (row === undefined) throw new InboxError("not_found", "inbox item not found");
    await this.close(orgId, itemId);
  }

  /** Marks an open item resolved; whether it was open. */
  async close(orgId: string, itemId: string): Promise<boolean> {
    const r = await this.kdb.db
      .updateTable("inbox_items")
      .set({ state: "resolved", resolved_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("id", "=", itemId)
      .where("state", "=", "open")
      .executeTakeFirst();
    return r.numUpdatedRows > 0n;
  }

  /** The open, unexpired item `itemId` of `accountId` in `orgId`, or `inbox.item_not_found`. */
  async openOf(orgId: string, accountId: string, itemId: string): Promise<OpenInboxItem> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const row = await this.kdb.db
      .selectFrom("inbox_items")
      .select(["id", "org_id", "account_id", "plugin", "actions"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("id", "=", itemId)
      .where("state", "=", "open")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (row === undefined) throw notFound();
    return {
      id: row.id,
      orgId: row.org_id,
      accountId: row.account_id,
      plugin: row.plugin,
      actions: row.actions,
    };
  }

  /**
   * The person dismisses their own open item (`POST inbox/items/:id/dismiss`): resolved without
   * calling anything. Not theirs, not open or expired -> `inbox.item_not_found`.
   */
  async dismiss(orgId: string, accountId: string, itemId: string): Promise<void> {
    await this.openOf(orgId, accountId, itemId);
    if (!(await this.close(orgId, itemId))) throw notFound();
  }

  /**
   * The open, unexpired items of `accountId` in `orgId`, newest first, at most
   * {@link INBOX_ITEMS_LIST_MAX}.
   */
  async listOpen(orgId: string, accountId: string): Promise<PersonalInboxItemView[]> {
    const db = this.kdb.db;
    const rows = await db
      .selectFrom("inbox_items")
      .select([
        "id",
        "source",
        "plugin",
        "kind",
        "title",
        "body",
        "link",
        "actions",
        "expires_at",
        "created_at",
      ])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("state", "=", "open")
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(INBOX_ITEMS_LIST_MAX)
      .execute();
    const names = await pluginDisplayNames(
      db,
      rows.flatMap((r) => (r.plugin === null ? [] : [r.plugin])),
    );
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      plugin: r.plugin,
      pluginName: r.plugin === null ? null : (names.get(r.plugin) ?? null),
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      actions: r.actions.map((a) => ({
        id: a.id,
        label: { zh: a.label.zh, en: a.label.en },
        ...(a.style !== undefined && { style: a.style }),
      })),
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    }));
  }
}

/**
 * {@link InboxItemsService}: infra and the push owing only, so the trigger dispatcher (kernel
 * items) and the extension host (`ctx.inbox`, through {@link INBOX_ITEMS_BACKEND} at the time of
 * use) reach it without a module cycle.
 */
@Module({
  imports: [PushOwedModule],
  providers: [InboxItemsService, { provide: INBOX_ITEMS_BACKEND, useExisting: InboxItemsService }],
  exports: [InboxItemsService, INBOX_ITEMS_BACKEND],
})
export class InboxItemsModule {}
