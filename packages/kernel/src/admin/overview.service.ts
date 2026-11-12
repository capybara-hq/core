import type { LocalizedName, Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  CATALOG_LIST_MAX_LIMIT,
  type CatalogItemView,
  CatalogService,
} from "../catalog/catalog.service.js";
import { MarketplacesService } from "../catalog/marketplaces.service.js";
import { ExtensionAdmin } from "../extensions/admin-view.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import type {
  AdminExtensionView,
  DeploymentExtensionStatus,
} from "../extensions/permission-view.js";
import { PluginIcons } from "../extensions/plugin-icons.js";
import { AccountsService } from "../identity/accounts.js";
import { PlatformInboxService } from "../inbox/platform-inbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { OrgsService } from "../orgs/orgs.service.js";
import { ProviderRegistry, type ProviderStatus } from "../runtime/providers.js";
import { QueueLostJobs } from "../runtime/queue-lost-jobs.js";
import { OutboxDeadService } from "./outbox-dead.service.js";

/** The most rows each attention list returns; the rest are counted in `more`. */
export const ATTENTION_LIST_MAX = 20;

/** The admin overview's numbers (`GET /api/v1/admin/overview`): counts only. */
export interface AdminOverviewStats {
  orgs: number;
  accounts: number;
  /**
   * What waits for a super admin: the platform inbox total plus the extensions, plugin updates and
   * model providers of {@link AdminAttention} (each counted in full, not capped), every dead
   * outbox row and the run queue's lost-jobs item.
   */
  attentionTotal: number;
  /** An attention source could not be read: `attentionTotal` leaves its items out. */
  partial: boolean;
}

/**
 * Why an extension needs a look (spec §5.2), from its status and `configValid`: `config` (missing
 * or invalid deployment config), `load_failed`, `approval` (permissions wait for confirmation),
 * `dependency`, `conflict`, `converging` (replicas disagree, or a migration waits) and
 * `legacy_format`. Never the raw replica detail.
 */
export type AttentionExtensionReason =
  | "config"
  | "load_failed"
  | "approval"
  | "dependency"
  | "conflict"
  | "converging"
  | "legacy_format";

/** What is wrong with a model provider: its model list failed, or it lists no usable chat model. */
export type AttentionProviderProblem = "list_failed" | "no_chat_model";

/** An attention list a source failed to read (it is then empty, the others intact). */
export type AttentionSource = "extensions" | "updates" | "providers" | "outbox" | "queue";

export interface AttentionExtension {
  name: string;
  displayName: LocalizedName | null;
  icon: string | null;
  status: DeploymentExtensionStatus;
  reason: AttentionExtensionReason;
}

/** A platform plugin whose marketplace has a newer version than the newest imported one. */
export interface AttentionUpdate {
  itemId: string;
  name: string;
  displayName: LocalizedName | null;
  icon: string | null;
  /** The newest imported version. */
  version: string;
  marketplaceVersion: string;
  marketplaceId: string | null;
  /** The marketplace's name; null without a marketplace (or when it was deleted). */
  marketplaceName: string | null;
}

export interface AttentionProvider {
  /** The model provider (its extension's plugin name). */
  plugin: string;
  displayName: LocalizedName | null;
  icon: string | null;
  problem: AttentionProviderProblem;
}

/**
 * Background work the kernel could not queue (transactional outbox spec §3.4): how many outbox
 * rows are dead and the oldest one's `dead_at`. One item for all of them; the rows themselves are
 * `GET /api/v1/admin/outbox/dead`.
 */
export interface AttentionOutboxDead {
  kind: "outbox_dead";
  count: number;
  oldestAt: string;
}

/**
 * The run queue lost background jobs (transactional outbox spec §8.3): the `run-orphan-check`
 * found queued runs whose job was neither in the queue nor owed, which only Redis losing data
 * explains. Their jobs were added again; the item says Redis durability needs a look, how many
 * jobs were lost and when last (it stays a week after the last loss).
 */
export interface AttentionQueueLostJobs {
  kind: "queue_lost_jobs";
  count: number;
  lastAt: string;
}

/**
 * `GET /api/v1/admin/overview/attention` (spec §5.2, §9): what needs a super admin besides the
 * inbox, each list at most {@link ATTENTION_LIST_MAX} rows with the rest counted in `more`, and
 * `unavailable` naming each source that could not be read. Reason categories only: never an error
 * text, a replica detail or a config value.
 */
export interface AdminAttention {
  extensions: AttentionExtension[];
  updates: AttentionUpdate[];
  providers: AttentionProvider[];
  /** System items: at most one, `outbox_dead`, when some outbox rows are dead. */
  outbox: AttentionOutboxDead[];
  /** System items: at most one, `queue_lost_jobs`, when the run queue lost jobs this week. */
  queue: AttentionQueueLostJobs[];
  more: Record<AttentionSource, number>;
  unavailable: AttentionSource[];
}

/** The reason an extension is listed, or null when it needs nothing. */
export function extensionReason(
  e: Pick<AdminExtensionView, "status" | "configValid">,
): AttentionExtensionReason | null {
  switch (e.status) {
    case "pending_config":
      return "config";
    case "failed":
      return "load_failed";
    case "pending_approval":
      return "approval";
    case "dependency":
    case "conflict":
    case "legacy_format":
      return e.status;
    case "converging":
    case "pending_migration":
      return "converging";
    case "enabled":
      return e.configValid ? null : "config";
    case "disabled":
      return null;
  }
}

/** The problem of a provider in the platform view, or null (`org_configured` is not one). */
export function providerProblem(p: ProviderStatus): AttentionProviderProblem | null {
  if (p.status === "error") return "list_failed";
  if (p.status !== "ok") return null;
  return p.models.some((m) => m.kind === "chat" && m.disabled !== true) ? null : "no_chat_model";
}

/**
 * The admin overview (spec §4.1, §5.2): its numbers and the 待处理 lists, read live from the
 * sources the admin pages read (`ExtensionAdmin`, the catalog, the provider registry's cached
 * lists, the dead outbox rows, the run queue's lost-jobs canary). Each source is read on its own: a failing one is reported in
 * `unavailable`. Reads are not audited (decision D5) and not cached further (every source is PG
 * or already Redis-cached).
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    @Inject(ExtensionAdmin) private readonly extensions: ExtensionAdmin,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(PlatformInboxService) private readonly inbox: PlatformInboxService,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(OutboxDeadService) private readonly outboxDead: OutboxDeadService,
    @Inject(QueueLostJobs) private readonly lostJobs: Pick<QueueLostJobs, "summary">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  async stats(): Promise<AdminOverviewStats> {
    const [orgs, accounts, inbox, attention] = await Promise.all([
      this.orgs.listAll(),
      this.accounts.count(),
      this.inbox.count(),
      this.attention(),
    ]);
    const listed = (s: Exclude<AttentionSource, "outbox" | "queue">) =>
      attention[s].length + attention.more[s];
    // each dead row waits for a super admin, not the one item that counts them
    const dead = attention.outbox.reduce((n, o) => n + o.count, 0);
    return {
      orgs: orgs.length,
      accounts,
      attentionTotal:
        inbox +
        listed("extensions") +
        listed("updates") +
        listed("providers") +
        dead +
        attention.queue.length,
      partial: attention.unavailable.length > 0,
    };
  }

  async attention(): Promise<AdminAttention> {
    // the catalog is read once: the update rows, and the plugins the inbox already lists
    const items = this.catalogItems();
    items.catch(() => {}); // awaited (and reported) by updateRows
    const [extensions, updates, providers, outbox, queue] = await Promise.allSettled([
      this.extensionRows(items),
      this.updateRows(items),
      this.providerRows(),
      this.outboxRows(),
      this.queueRows(),
    ]);
    const out: AdminAttention = {
      extensions: [],
      updates: [],
      providers: [],
      outbox: [],
      queue: [],
      more: { extensions: 0, updates: 0, providers: 0, outbox: 0, queue: 0 },
      unavailable: [],
    };
    /** The rows of a source that answered (capped), or none and its name in `unavailable`. */
    const take = <T>(source: AttentionSource, r: PromiseSettledResult<T[]>): T[] => {
      if (r.status === "rejected") {
        // logged for the operator; the answer carries only the source's name (spec §9)
        this.log.warn("admin overview: an attention source could not be read", {
          source,
          err: r.reason,
        });
        out.unavailable.push(source);
        return [];
      }
      out.more[source] = Math.max(0, r.value.length - ATTENTION_LIST_MAX);
      return r.value.slice(0, ATTENTION_LIST_MAX);
    };
    out.extensions = take("extensions", extensions);
    out.updates = take("updates", updates);
    out.providers = take("providers", providers);
    out.outbox = take("outbox", outbox);
    out.queue = take("queue", queue);
    return out;
  }

  /** The `queue_lost_jobs` item when the run queue lost jobs this week, else none. */
  private async queueRows(): Promise<AttentionQueueLostJobs[]> {
    const lost = await this.lostJobs.summary();
    return lost === null ? [] : [{ kind: "queue_lost_jobs", ...lost }];
  }

  /** The `outbox_dead` item when some outbox rows are dead, else none. */
  private async outboxRows(): Promise<AttentionOutboxDead[]> {
    const { count, oldestAt } = await this.outboxDead.summary();
    if (count === 0 || oldestAt === null) return [];
    return [{ kind: "outbox_dead", count, oldestAt: oldestAt.toISOString() }];
  }

  /**
   * The extensions needing a look, but not one pending approval whose plugin waits in the platform
   * inbox (a permission confirmation or an org upload: the inbox already lists and counts it). A
   * config-declared extension has no catalog item and stays. Without the catalog nothing is left out.
   */
  private async extensionRows(items: Promise<CatalogItemView[]>): Promise<AttentionExtension[]> {
    const [views, catalog] = await Promise.all([this.extensions.list(), items.catch(() => [])]);
    const inInbox = new Set(catalog.filter((i) => i.pending).map((i) => i.name));
    return views.flatMap((v) => {
      // every status of extensionNeedsAction has a reason, and so has enabled with an invalid config
      const reason = extensionReason(v);
      if (reason === null) return [];
      if (v.status === "pending_approval" && inInbox.has(v.name)) return [];
      return [
        {
          name: v.name,
          displayName: v.displayName,
          icon: v.icon ?? null,
          status: v.status,
          reason,
        },
      ];
    });
  }

  /** Every live catalog item, page by page (the catalog lists by name). */
  private async catalogItems(): Promise<CatalogItemView[]> {
    const items: CatalogItemView[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.catalog.page({ limit: CATALOG_LIST_MAX_LIMIT, offset });
      items.push(...page.items);
      offset = page.nextOffset;
    }
    return items;
  }

  /** Platform plugins with a newer marketplace version (org items are their org admins'). */
  private async updateRows(items: Promise<CatalogItemView[]>): Promise<AttentionUpdate[]> {
    const newer = (await items).filter(
      (i) =>
        i.owner.kind === "platform" && i.newerInMarketplace && i.latestMarketplaceVersion !== null,
    );
    if (newer.length === 0) return [];
    const [icons, marketplaces] = await Promise.all([
      this.icons.ofItems(
        newer.map((i) => i.id),
        { kind: "admin" },
      ),
      this.marketplaces.list(),
    ]);
    const names = new Map(marketplaces.map((m) => [m.id, m.name]));
    return newer.map((i) => ({
      itemId: i.id,
      name: i.name,
      displayName: i.displayName,
      icon: icons.get(i.id) ?? null,
      version: i.latestVersion,
      marketplaceVersion: i.latestMarketplaceVersion as string,
      marketplaceId: i.marketplaceId,
      marketplaceName: i.marketplaceId === null ? null : (names.get(i.marketplaceId) ?? null),
    }));
  }

  private async providerRows(): Promise<AttentionProvider[]> {
    const problems = (await this.registry.listWithStatus()).flatMap((p) => {
      const problem = providerProblem(p);
      return problem === null ? [] : [{ plugin: p.plugin, problem }];
    });
    if (problems.length === 0) return [];
    const plugins = problems.map((p) => p.plugin);
    const [names, icons] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, { kind: "admin" }),
    ]);
    return problems.map((p) => ({
      plugin: p.plugin,
      displayName: names.get(p.plugin) ?? null,
      icon: icons.get(p.plugin) ?? null,
      problem: p.problem,
    }));
  }
}
