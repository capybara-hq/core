import type { LocalizedName, Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  CATALOG_LIST_MAX_LIMIT,
  type CatalogItemView,
  CatalogService,
} from "../catalog/catalog.service.js";
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

/** The most rows each attention list returns; the rest are counted in `more`. */
export const ATTENTION_LIST_MAX = 20;

/** The admin overview's numbers (`GET /api/v1/admin/overview`): counts only. */
export interface AdminOverviewStats {
  orgs: number;
  accounts: number;
  /**
   * What waits for a super admin: the platform inbox total plus the extensions, plugin updates and
   * model providers of {@link AdminAttention} (each counted in full, not capped).
   */
  attentionTotal: number;
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
export type AttentionSource = "extensions" | "updates" | "providers";

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
}

export interface AttentionProvider {
  /** The model provider (its extension's plugin name). */
  plugin: string;
  displayName: LocalizedName | null;
  icon: string | null;
  problem: AttentionProviderProblem;
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
 * lists). Each source is read on its own: a failing one is reported in `unavailable`. Reads are not
 * audited (decision D5) and not cached further (every source is PG or already Redis-cached).
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
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  async stats(): Promise<AdminOverviewStats> {
    const [orgs, accounts, inbox, attention] = await Promise.all([
      this.orgs.listAll(),
      this.accounts.count(),
      this.inbox.count(),
      this.attention(),
    ]);
    const listed = (s: AttentionSource) => attention[s].length + attention.more[s];
    return {
      orgs: orgs.length,
      accounts,
      attentionTotal: inbox + listed("extensions") + listed("updates") + listed("providers"),
    };
  }

  async attention(): Promise<AdminAttention> {
    const [extensions, updates, providers] = await Promise.allSettled([
      this.extensionRows(),
      this.updateRows(),
      this.providerRows(),
    ]);
    const out: AdminAttention = {
      extensions: [],
      updates: [],
      providers: [],
      more: { extensions: 0, updates: 0, providers: 0 },
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
    return out;
  }

  private async extensionRows(): Promise<AttentionExtension[]> {
    const views = await this.extensions.list();
    return views.flatMap((v) => {
      // every status of extensionNeedsAction has a reason, and so has enabled with an invalid config
      const reason = extensionReason(v);
      if (reason === null) return [];
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

  /** Every live platform item, page by page (the catalog lists by name). */
  private async platformItems(): Promise<CatalogItemView[]> {
    const items: CatalogItemView[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.catalog.page({ limit: CATALOG_LIST_MAX_LIMIT, offset });
      items.push(...page.items);
      offset = page.nextOffset;
    }
    return items.filter((i) => i.owner.kind === "platform");
  }

  private async updateRows(): Promise<AttentionUpdate[]> {
    const newer = (await this.platformItems()).filter(
      (i) => i.newerInMarketplace && i.latestMarketplaceVersion !== null,
    );
    if (newer.length === 0) return [];
    const icons = await this.icons.ofItems(
      newer.map((i) => i.id),
      { kind: "admin" },
    );
    return newer.map((i) => ({
      itemId: i.id,
      name: i.name,
      displayName: i.displayName,
      icon: icons.get(i.id) ?? null,
      version: i.latestVersion,
      marketplaceVersion: i.latestMarketplaceVersion as string,
      marketplaceId: i.marketplaceId,
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
