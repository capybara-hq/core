import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  type AutomationAttention,
  AutomationsService,
} from "../automations/automations.service.js";
import {
  AcceptanceService,
  type AutomationOfferView,
  OFFERS_LIST_MAX,
} from "../automations/events/acceptance.js";
import {
  CATALOG_REQUESTS_LIST_MAX,
  CatalogRequestsService,
  type CatalogRequestView,
} from "../catalog/requests.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { roleAtLeast } from "../orgs/roles.js";
import {
  SKILL_CHANGES_LIST_MAX,
  SkillChangesService,
  type SkillChangeView,
} from "../skills/changes.service.js";
import {
  APPROVALS_LIST_MAX,
  ApprovalsService,
  type ApprovalView,
} from "../tools/approvals.service.js";
import {
  INBOX_ITEMS_LIST_MAX,
  InboxItemsService,
  type PersonalInboxItemView,
} from "./inbox-items.service.js";
import type { OrgNoticeDetails } from "./org-notices.js";

/** The most open org notices one inbox read returns. */
export const ORG_NOTICES_LIST_MAX = 100;

/**
 * A notice for the org's admins (`org_notices`), shown until one of them dismisses it:
 * `item_shared`, `shared_item_updated`, `upload_confirmed`, `upload_rejected`, `detail` in the
 * shape of {@link OrgNoticeDetails} (plugin scope phase 3, P3-22).
 */
export type OrgNoticeView = { id: string; createdAt: string } & {
  [K in keyof OrgNoticeDetails]: { kind: K; detail: OrgNoticeDetails[K] };
}[keyof OrgNoticeDetails];

/** The most items one inbox read returns. */
export const INBOX_MAX_ITEMS = 100;

/**
 * One inbox entry (told apart by `type`, stable shapes):
 * - `tool_approval`: a pending tool call approval the current user can decide (the same view as
 *   `GET /approvals?status=pending`);
 * - `skill_change`: pending skill share requests and proposed versions of shared skills, when the
 *   current user is an org admin (`skillChange.kind`; spec §5.4, §5.5);
 * - `catalog_request`: pending `enable` and `network_allowlist` requests from members and pending
 *   `connector_setup` requests (`request.kind`; for `connector_setup` `request.agent` and
 *   `request.connectors` set, `item` null, ruling P4-T6-5; for `network_allowlist`
 *   `request.network` set, network ask-to-allow spec §5.3), when the current user is an org admin
 *   (M6 T26, C22; plugin scope spec §5.1);
 * - `catalog_request_decided`: the current user's own requests in this org that were approved or
 *   rejected (with the reason), until dismissed (`POST catalog-requests/:id/dismiss`);
 * - `automation_attention`: the current user's own automation that needs them (spec §8): paused
 *   for any reason but their own pause, its latest run failed, or its latest run was refused tools
 *   or connections; derived live, gone once the task is resumed or runs clean;
 * - the org notices (`item_shared`, `shared_item_updated`, `upload_confirmed`,
 *   `upload_rejected`; `type` = the notice's kind): for org admins, until one dismisses it
 *   (`POST inbox/notices/:id/dismiss`);
 * - `item`: the current user's own open personal items (`inbox_items`, collaboration spec §4.9),
 *   posted by the kernel or an extension, until they click an action or dismiss it
 *   (`POST inbox/items/:id/actions/:actionId`, `POST inbox/items/:id/dismiss`) or it expires;
 *   a work offer's push-carrying item (kernel kind `automation_offer`) is shown as the offer;
 * - `automation_offer`: work an extension assigned to the current user and their agent, waiting
 *   for them under a `confirm` acceptance rule (collaboration spec §4.4), until they accept or
 *   decline it (`POST automations/offers/:id/accept|decline`) or it expires (seven days).
 */
export type InboxItem =
  | { type: "tool_approval"; id: string; createdAt: string; approval: ApprovalView }
  | { type: "skill_change"; id: string; createdAt: string; skillChange: SkillChangeView }
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequestView }
  | {
      type: "catalog_request_decided";
      id: string;
      /** When it was decided. */
      createdAt: string;
      request: CatalogRequestView;
    }
  | {
      type: "automation_attention";
      /** `<taskId>:paused`, `<taskId>:failed` or `<taskId>:grants`. */
      id: string;
      createdAt: string;
      attention: AutomationAttentionView;
    }
  | { type: "item"; id: string; createdAt: string; item: PersonalInboxItemView }
  | { type: "automation_offer"; id: string; createdAt: string; offer: AutomationOfferView }
  | {
      type: OrgNoticeView["kind"];
      id: string;
      createdAt: string;
      notice: OrgNoticeView;
    };

/** An automation that needs its creator ({@link AutomationAttention}, dates as ISO strings). */
export type AutomationAttentionView = Omit<AutomationAttention, "at">;

/** What `GET /inbox` answers: newest first, at most {@link INBOX_MAX_ITEMS}; `truncated`: more wait. */
export interface InboxView {
  items: InboxItem[];
  truncated: boolean;
}

/** The inbox (plan decision C6): what waits, gathered by type from each source; read live from PG. */
@Injectable()
export class InboxService {
  constructor(
    @Inject(ApprovalsService) private readonly approvals: Pick<ApprovalsService, "list">,
    @Inject(SkillChangesService)
    private readonly skillChanges: Pick<SkillChangesService, "listPending">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CatalogRequestsService)
    private readonly catalogRequests: Pick<
      CatalogRequestsService,
      "listForOrgAdmin" | "listDecidedForRequester"
    >,
    @Inject(AutomationsService)
    private readonly automations: Pick<AutomationsService, "attentionFor">,
    @Inject(InboxItemsService) private readonly items: Pick<InboxItemsService, "listOpen">,
    @Inject(AcceptanceService) private readonly acceptance: Pick<AcceptanceService, "openOffers">,
  ) {}

  async list(orgId: string, accountId: string): Promise<InboxView> {
    const [approvals, changes, requests, decided, notices, attention, allItems, offers] =
      await Promise.all([
        this.approvals.list(orgId, accountId, "pending"),
        this.skillChanges.listPending(orgId, accountId),
        this.catalogRequests.listForOrgAdmin(orgId, accountId),
        this.catalogRequests.listDecidedForRequester(orgId, accountId),
        this.notices(orgId, accountId),
        this.automations.attentionFor(orgId, accountId),
        this.items.listOpen(orgId, accountId),
        this.acceptance.openOffers(orgId, accountId),
      ]);
    // an offer's own item carries its push; the inbox shows the offer (with accept and decline)
    const items = allItems.filter((i) => !(i.source === "kernel" && i.kind === "automation_offer"));
    const all: InboxItem[] = [
      ...approvals.map(
        (a): InboxItem => ({
          type: "tool_approval",
          id: a.id,
          createdAt: a.createdAt,
          approval: a,
        }),
      ),
      ...changes.map(
        (c): InboxItem => ({
          type: "skill_change",
          id: c.id,
          createdAt: c.createdAt,
          skillChange: c,
        }),
      ),
      ...requests.map(
        (r): InboxItem => ({
          type: "catalog_request",
          id: r.id,
          createdAt: r.createdAt,
          request: r,
        }),
      ),
      ...decided.map(
        (r): InboxItem => ({
          type: "catalog_request_decided",
          id: r.id,
          createdAt: r.decidedAt ?? r.createdAt,
          request: r,
        }),
      ),
      ...attention.map(
        ({ at, ...view }): InboxItem => ({
          type: "automation_attention",
          id: `${view.taskId}:${view.reason === "missing_grants" ? "grants" : view.reason === "failed" ? "failed" : "paused"}`,
          createdAt: at.toISOString(),
          attention: view,
        }),
      ),
      ...notices.map(
        (n): InboxItem => ({ type: n.kind, id: n.id, createdAt: n.createdAt, notice: n }),
      ),
      ...items.map((i): InboxItem => ({ type: "item", id: i.id, createdAt: i.createdAt, item: i })),
      ...offers.map(
        (o): InboxItem => ({
          type: "automation_offer",
          id: o.id,
          createdAt: o.createdAt,
          offer: o,
        }),
      ),
    ];
    // newest first; the id orders items of the same moment (a stable result)
    all.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    // each source has its own cap: one read in full counts as more waiting
    const full =
      approvals.length >= APPROVALS_LIST_MAX ||
      changes.length >= SKILL_CHANGES_LIST_MAX ||
      requests.length >= CATALOG_REQUESTS_LIST_MAX ||
      decided.length >= CATALOG_REQUESTS_LIST_MAX ||
      notices.length >= ORG_NOTICES_LIST_MAX ||
      allItems.length >= INBOX_ITEMS_LIST_MAX ||
      offers.length >= OFFERS_LIST_MAX;
    return {
      items: all.slice(0, INBOX_MAX_ITEMS),
      truncated: full || all.length > INBOX_MAX_ITEMS,
    };
  }

  /** The org's open notices when the account is an org admin (else none), newest first. */
  private async notices(orgId: string, accountId: string): Promise<OrgNoticeView[]> {
    if (!(await this.isAdmin(orgId, accountId))) return [];
    const rows = await this.kdb.db
      .selectFrom("org_notices")
      .select(["id", "kind", "detail", "created_at"])
      .where("org_id", "=", orgId)
      .where("dismissed_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(ORG_NOTICES_LIST_MAX)
      .execute();
    return rows.map((r): OrgNoticeView => {
      const base = { id: r.id, createdAt: r.created_at.toISOString() };
      return { ...base, kind: r.kind, detail: r.detail } as OrgNoticeView;
    });
  }

  /**
   * An org admin dismisses an open notice (`POST /orgs/:orgId/inbox/notices/:id/dismiss`); for
   * every admin of the org. Not an admin, or no open notice of the org with that id ->
   * `inbox.notice_not_found`.
   */
  async dismissNotice(orgId: string, accountId: string, id: string): Promise<void> {
    const notFound = new ApiError("inbox.notice_not_found", "Notice not found");
    if (!UUID_RE.test(id) || !(await this.isAdmin(orgId, accountId))) throw notFound;
    const r = await this.kdb.db
      .updateTable("org_notices")
      .set({ dismissed_at: sql<Date>`now()`, dismissed_by: accountId })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw notFound;
  }

  private async isAdmin(orgId: string, accountId: string): Promise<boolean> {
    const m = await this.kdb.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return m !== undefined && roleAtLeast(m.role, "admin");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
