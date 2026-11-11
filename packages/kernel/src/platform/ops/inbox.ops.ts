import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { CatalogRequestView } from "../../catalog/requests.service.js";
import { InboxNoticeParams } from "../../inbox/inbox.schemas.js";
import { type InboxItem, InboxService, type OrgNoticeView } from "../../inbox/inbox.service.js";
import type { OrgNoticeDetails } from "../../inbox/org-notices.js";
import {
  type PlatformInboxItem,
  PlatformInboxService,
} from "../../inbox/platform-inbox.service.js";
import type { PlatformNoticeDetails } from "../../inbox/platform-notices.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { roleAtLeast } from "../../orgs/roles.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { approvalRow } from "./approvals.ops.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named, orElse } from "./summary.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NoticeInput = z.object({ id: InboxNoticeParams.shape.id }).strict();
const NOTICE_EXAMPLE = { id: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c" };

const NOT_FOUND: PrecheckResult = {
  ok: false,
  code: "inbox.notice_not_found",
  message: "Notice not found",
};

const DECIDE_REQUEST_ON_WEB = "Decide it on the web, in the inbox; agents never decide requests.";
const DISMISS_ORG = "Dismiss it with inbox.dismiss-notice once read.";
const ADMIN_CONSOLE_PENDING =
  "Review it in the admin console (plugins, pending tab); agents never confirm permissions or uploads.";

/** What a request asks for, by name (the plugin, the marketplace entry or the agent). */
const requestName = (r: CatalogRequestView): string =>
  r.item?.name ?? r.entry?.name ?? r.agent?.name ?? r.kind;

const requester = (r: CatalogRequestView): string => r.requestedByName ?? "a deleted account";

/** The name an org notice is about. */
const orgNoticeName = (n: OrgNoticeView): string =>
  n.kind === "skill_renamed" ? n.skillRenamed.to : n.detail.name;

/** An org notice in one English sentence, as the inbox tells it. */
function orgNoticeSummary(n: OrgNoticeView): string {
  switch (n.kind) {
    case "skill_renamed":
      return `Skill "${n.skillRenamed.from}" was renamed to "${n.skillRenamed.to}": a platform skill on in this org has its name; agents keep it.`;
    case "item_shared": {
      const d = n.detail as OrgNoticeDetails["item_shared"];
      return `${d.ref.kind} ${d.name} was shared with ${d.org === "all_orgs" ? "every org" : d.org.name}.`;
    }
    case "shared_item_updated": {
      const d = n.detail as OrgNoticeDetails["shared_item_updated"];
      return `Shared ${d.ref.kind} ${d.name} changed from ${d.from} to ${d.to}.`;
    }
    case "upload_confirmed": {
      const d = n.detail as OrgNoticeDetails["upload_confirmed"];
      return `The super admin confirmed the upload of ${d.name} ${d.version}.`;
    }
    case "upload_rejected": {
      const d = n.detail as OrgNoticeDetails["upload_rejected"];
      return `The super admin rejected the upload of ${d.name} ${d.version}: ${d.reason ?? "no reason given"}.`;
    }
  }
}

/**
 * An org inbox item as `inbox.list` shows it: a compact row with the summary the inbox shows.
 * Approvals carry their kernel-rendered summary, never the call's input (Review Focus 5); skill
 * changes their file count, never file contents.
 */
function orgRow(i: InboxItem) {
  const base = { id: i.id, type: i.type, createdAt: i.createdAt };
  switch (i.type) {
    case "tool_approval": {
      const a = approvalRow(i.approval);
      const what = a.summary ?? `Call of ${a.name}`;
      return {
        ...base,
        name: a.name,
        state: a.state,
        summary: `${what} (agent ${a.agent}). Details: approvals.get.`,
        ...(a.next !== undefined && { next: a.next }),
      };
    }
    case "skill_change": {
      const c = i.skillChange;
      const what = c.skillId === null ? "a new skill" : `version ${c.version}`;
      return {
        ...base,
        name: c.name,
        state: c.status,
        summary: `Skill change for agent ${c.agent.name} by ${c.requestedByName || "a deleted account"}: ${what}, ${c.files.length} file(s).`,
        next: "Review and decide it on the web, in the inbox; agents never decide skill changes.",
      };
    }
    case "catalog_request": {
      const r = i.request;
      return {
        ...base,
        name: requestName(r),
        state: r.status,
        summary: `${r.kind} request from ${requester(r)}. Details: requests.pending.`,
        next: DECIDE_REQUEST_ON_WEB,
      };
    }
    case "catalog_request_decided": {
      const r = i.request;
      return {
        ...base,
        name: requestName(r),
        state: r.status,
        summary: `Your ${r.kind} request was ${r.status}${r.reason ? `: ${r.reason}` : ""}.`,
      };
    }
    case "schedule_attention": {
      const a = i.attention;
      const summary =
        a.reason === "missing_grants"
          ? `Scheduled task "${a.name}" ran without: ${a.missing.join(", ")}.${a.needsRole.length > 0 ? ` Needing a higher role than the owner has (cannot be pre-approved): ${a.needsRole.join(", ")}.` : ""}`
          : a.reason === "failed"
            ? `Scheduled task "${a.name}"'s latest run failed${a.error ? `: ${a.error}` : ""}.`
            : `Scheduled task "${a.name}" is paused (${a.reason}${a.pausedBy ? ` by ${a.pausedBy.name || a.pausedBy.id}` : ""}).`;
      return {
        ...base,
        name: a.name,
        state: a.reason,
        summary,
        next:
          a.reason === "missing_grants"
            ? "Add the missing tools to the task's approved tools and connect the missing connectors on the web; tools that need a higher role cannot be pre-approved."
            : a.reason === "failed"
              ? "Check the run's error and the task's settings; the next good run clears this, and repeated failures pause the task."
              : "Resume the task once the cause is fixed.",
      };
    }
    default: {
      const n = (i as { notice: OrgNoticeView }).notice;
      return {
        ...base,
        name: orgNoticeName(n),
        state: "open",
        summary: orgNoticeSummary(n),
        next: DISMISS_ORG,
      };
    }
  }
}

/** A platform notice's subject, as the inbox tells it. */
const platformNoticeSummary = (d: PlatformNoticeDetails["ownership_transferred"]): string =>
  `${d.ref.kind} ${d.name} of ${d.reason === "org_deleted" ? "deleted org" : "org"} ${d.fromOrg.name} now belongs to the platform; ${d.usedBy} other org(s) use it.`;

/** A platform inbox item as `inbox.platform-list` shows it: a compact row (admin data in full). */
function platformRow(i: PlatformInboxItem) {
  const base = { id: i.id, type: i.type, createdAt: i.createdAt };
  switch (i.type) {
    case "catalog_request": {
      const r = i.request;
      return {
        ...base,
        name: requestName(r),
        state: r.status,
        summary: `${r.kind} request from org ${r.orgName} by ${requester(r)}. Details: requests.platform-list.`,
        next: "Decide it in the admin console (plugins, pending tab); agents never decide requests.",
      };
    }
    case "permission_confirmation":
      return {
        ...base,
        name: i.item.name,
        state: "pending",
        summary: `Plugin ${i.item.name} ${i.item.latestVersion} waits for a super admin to confirm its extension permissions. Details: extensions.pending-permissions.`,
        next: ADMIN_CONSOLE_PENDING,
      };
    case "org_upload_pending":
      return {
        ...base,
        name: i.item.name,
        state: "pending",
        summary: `This org uploaded ${i.item.name} ${i.item.pendingVersion ?? i.item.latestVersion} with an extension; it waits for a super admin.`,
        next: ADMIN_CONSOLE_PENDING,
      };
    case "scope_sync_failed": {
      const f = i.failure;
      return {
        ...base,
        name: f.item.name,
        state: "failed",
        summary: `The scope sync could not ${f.op === "dependencies" ? "install the dependencies of" : f.op} ${f.item.name} in org ${f.org.name}: ${f.code}.`,
        next: "Open the plugin in the admin console to see the error and retry.",
      };
    }
    case "platform_migration": {
      const r = i.run;
      const failed = r.itemsFailed.slice(0, 5).join(", ");
      return {
        ...base,
        name: "platform components migration",
        state: r.stuck ? "stuck" : "failed",
        summary: r.stuck
          ? "The platform components migration run has not finished for over an hour; its worker stopped. The next run starts at the next worker start or day."
          : `The platform components migration could not write ${r.itemsFailed.length} catalog item(s): ${failed}${r.itemsFailed.length > 5 ? ", …" : ""}. The next run tries them again.`,
      };
    }
    case "ownership_transferred":
      return {
        ...base,
        name: i.notice.detail.name,
        state: "open",
        summary: platformNoticeSummary(i.notice.detail),
        next: "Dismiss it with inbox.platform-dismiss-notice once read.",
      };
  }
}

/**
 * The inbox operations of the `Platform` tool (spec §14.1 item 2, §14.2): my inbox in this org
 * (approvals waiting for me, requests for the org admins, decided requests, org notices) and the
 * super admin's platform inbox, as compact rows with the summaries the inbox shows. Dismissing a
 * notice is offered; deciding an approval, a request or a permission confirmation is not.
 */
@Injectable()
export class InboxOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(PlatformInboxService) private readonly platformInbox: PlatformInboxService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The org's open notice `id` when the actor is an org admin (else null: not found). */
  private async orgNotice(orgId: string, accountId: string, id: string) {
    if (!UUID_RE.test(id)) return null;
    const m = await this.kdb.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (m === undefined || !roleAtLeast(m.role, "admin")) return null;
    const row = await this.kdb.db
      .selectFrom("org_notices")
      .select(["id", "kind", "detail", "created_at"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const base = { id: row.id, createdAt: row.created_at.toISOString() };
    return (
      row.kind === "skill_renamed"
        ? { ...base, kind: row.kind, skillRenamed: row.detail }
        : { ...base, kind: row.kind, detail: row.detail }
    ) as OrgNoticeView;
  }

  /** A platform notice by id (dismissed or not), or null. */
  private async platformNotice(id: string) {
    if (!UUID_RE.test(id)) return null;
    const row = await this.kdb.db
      .selectFrom("platform_notices")
      .select(["id", "detail"])
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined
      ? null
      : (row.detail as unknown as PlatformNoticeDetails["ownership_transferred"]);
  }

  /** Org ids that own each of `itemIds` (platform items: absent). */
  private async owners(itemIds: readonly string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();
    const rows = await this.kdb.db
      .selectFrom("catalog_items")
      .select(["id", "owner_org_id"])
      .where("id", "in", [...itemIds])
      .execute();
    return new Map(rows.flatMap((r) => (r.owner_org_id === null ? [] : [[r.id, r.owner_org_id]])));
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "inbox.list",
        description:
          "List your inbox in this org, newest first, one compact row each (type, what it is about, state, the summary the inbox shows, your next step): tool call approvals waiting for you, skill changes you can decide, and for org admins the members' pending requests and the org's notices; your own decided requests too. Never a call's input. Deciding is done by you on the web; notices can be dismissed with inbox.dismiss-notice. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "approvals.decide" },
        mirrors: ["GET /api/v1/orgs/:orgId/inbox"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const view = await this.inbox.list(ctx.orgId, ctx.actorAccountId);
          return {
            ...pageOf(view.items.map(orgRow), startOf(input.cursor), 50),
            truncated: view.truncated,
          };
        },
      }),
      defineOperation({
        id: "inbox.dismiss-notice",
        description:
          "Dismiss an org notice from the inbox for every org admin (org admins): the id of a notice row from inbox.list (types skill_renamed, item_shared, shared_item_updated, upload_confirmed, upload_rejected). Approvals and requests are not dismissed here: they are decided on the web.",
        input: NoticeInput,
        example: NOTICE_EXAMPLE,
        authz: { orgAction: "catalog.decide" },
        authzNote: "service-enforced",
        mirrors: ["POST /api/v1/orgs/:orgId/inbox/notices/:id/dismiss"],
        confirm: "org",
        errors: [
          {
            code: "inbox.notice_not_found",
            next: "No open notice of this org has that id; list the open ones with inbox.list (notice rows only).",
          },
        ],
        precheck: async (input, ctx) =>
          (await this.orgNotice(ctx.orgId, ctx.actorAccountId, input.id)) === null
            ? NOT_FOUND
            : { ok: true },
        summary: async (input, ctx) => {
          const n = await orElse(
            () => this.orgNotice(ctx.orgId, ctx.actorAccountId, input.id),
            null,
          );
          const name = named(n === null ? input.id : orgNoticeName(n));
          return {
            zh: `为组织管理员关闭关于「${name}」的通知`,
            en: `Dismiss the org notice about "${name}" for the org admins`,
          };
        },
        run: async (input, ctx) => {
          await this.inbox.dismissNotice(ctx.orgId, ctx.actorAccountId, input.id);
          return { dismissed: input.id };
        },
      }),
      defineOperation({
        id: "inbox.platform-list",
        description:
          "List the platform inbox (super admin), newest first, one compact row each (type, what, state, summary, next step): orgs' requests to the platform, plugins waiting for a permission confirmation, this org's uploads waiting for you, failed scope syncs, a failed or stuck components migration and ownership notices. Only the newest 100 items are read (truncated: more wait); listed is how many of them are shown, otherOrgItems how many are items of plugins other orgs own (only counted). total counts everything waiting on the platform, other orgs' items included, as the admin console does. Nothing is decided here: requests and confirmations are done in the admin console. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/inbox", "GET /api/v1/admin/inbox/count"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const view = await this.platformInbox.list();
          const itemIds = view.items.flatMap((i) =>
            i.type === "org_upload_pending" || i.type === "permission_confirmation"
              ? [i.item.id]
              : i.type === "scope_sync_failed"
                ? [i.failure.item.id]
                : [],
          );
          const owners = await this.owners(itemIds);
          const theirs = (itemId: string) => {
            const o = owners.get(itemId);
            return o !== undefined && o !== ctx.orgId;
          };
          const shown = view.items.filter(
            (i) =>
              !(
                ((i.type === "org_upload_pending" || i.type === "permission_confirmation") &&
                  theirs(i.item.id)) ||
                (i.type === "scope_sync_failed" && theirs(i.failure.item.id))
              ),
          );
          const page = pageOf(shown.map(platformRow), startOf(input.cursor), 50);
          // total is the console's count of everything waiting (other orgs' items included): when
          // the inbox is truncated the items past the newest 100 cannot be told apart, so the
          // count is never reduced by a guess; listed and otherOrgItems are of the listed window
          return {
            ...page,
            total: view.total,
            listed: shown.length,
            truncated: view.truncated,
            otherOrgItems: view.items.length - shown.length,
          };
        },
      }),
      defineOperation({
        id: "inbox.platform-dismiss-notice",
        description:
          "Dismiss a platform notice (super admin) for every super admin: the id of an ownership_transferred row from inbox.platform-list. Other platform inbox items go away when they are dealt with in the admin console.",
        input: NoticeInput,
        example: NOTICE_EXAMPLE,
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/inbox/notices/:id/dismiss"],
        confirm: "platform",
        errors: [
          {
            code: "inbox.notice_not_found",
            next: "No platform notice has that id; list them with inbox.platform-list (ownership_transferred rows).",
          },
        ],
        precheck: async (input) =>
          (await this.platformNotice(input.id)) === null ? NOT_FOUND : { ok: true },
        summary: async (input) => {
          const d = await orElse(() => this.platformNotice(input.id), null);
          const name = named(d === null ? input.id : d.name);
          return {
            zh: `为超级管理员关闭关于「${name}」的平台通知`,
            en: `Dismiss the platform notice about "${name}" for the super admins`,
          };
        },
        run: async (input, ctx) => {
          await this.platformInbox.dismissNotice(ctx.actorAccountId, input.id);
          return { dismissed: input.id };
        },
      }),
    ]);
  }
}
