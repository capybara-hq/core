import {
  type PluginManifest,
  parseSlotRef,
  type SuggestedAppearance,
  UI_ARRANGEABLE_SLOTS,
  type UiSlotId,
  uiSlot,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ExtensionHost } from "../extensions/host.js";
import { IdentityModule } from "../identity/identity.module.js";
import { readUiArrangement, readUiTheme, SettingsService } from "../identity/settings.js";
import { SuperAdminLock, SuperAdminLockModule } from "../identity/super-admin.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock, OrgLockModule } from "../orgs/org-lock.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { OrgSettingsService, readOrgSettings } from "../orgs/settings.service.js";
import {
  assertPlatformDefaultEligible,
  themeNotAvailable,
  themeOnIn,
} from "../themes/theme-state.js";
import { ORG_ARRANGEABLE, type UiArrangement, type UiArrangementEntry } from "../ui/arrangement.js";

/** Where the suggestion is applied: the platform defaults, or one org's. */
export type AppearanceLevel = { platform: true } | { orgId: string };

/** Why a replacement of the suggestion was left out (client extensions spec §6.5). */
export type AppearanceSkipReason = "unknown-slot" | "not-available" | "not-eligible";

/**
 * What applying a suggestion changes at its level: the default theme (`from`: the theme the level
 * stores, null for none; `to`: the `platform_themes` id; null when the plugin suggests no theme or
 * the level stores it already), each replacement slot's `use` (`to`: the contribution key
 * `<extension>/<contribution>`; a slot that already uses it is not listed) and what was skipped.
 */
export interface AppearanceResult {
  theme: { from: string | null; to: string } | null;
  replacements: { slot: string; from: string | null; to: string }[];
  skipped: { what: string; reason: AppearanceSkipReason }[];
}

/** Who applies it: the account, the PAT when one made the call, and extra audit detail. */
export interface AppearanceActor {
  accountId: string;
  tokenId?: string;
  /** Merged into the settings writer's audit detail (the Platform tool's `via: "agent"`). */
  auditDetail?: Record<string, unknown>;
}

/** The suggestion of a plugin's catalog version, or null (none, or not an object). */
export function suggestedAppearanceOf(manifest: unknown): SuggestedAppearance | null {
  const sa = (manifest as Pick<PluginManifest, "suggestedAppearance"> | null)?.suggestedAppearance;
  return sa !== null && typeof sa === "object" ? sa : null;
}

/** The catalog item a suggestion comes from. */
interface SuggestingItem {
  id: string;
  name: string;
  suggestion: SuggestedAppearance;
}

/** The writes a plan makes: the theme and the arrangement patch (both absent: nothing to do). */
interface AppearancePlan {
  result: AppearanceResult;
  theme?: string;
  arrangement: Partial<Record<UiSlotId, UiArrangementEntry>>;
}

const itemNotFound = () =>
  new ApiError("catalog.item_not_found", "No such plugin, or it suggests no appearance");
const extensionNotFound = () =>
  new ApiError(
    "extension.not_found",
    "No such extension on in this organization, or its plugin suggests no appearance",
  );

const useOf = (e: UiArrangementEntry | undefined): string | null =>
  e !== undefined && "use" in e ? e.use : null;

/**
 * "Apply this plugin's appearance" (client extensions spec §6.5): one step that sets the plugin's
 * suggested theme as the level's default theme and each suggested replacement as the level's `use`
 * of its single slot. The writes go through the settings writers (`SettingsService.update` for the
 * platform, `OrgSettingsService.update` for an org), so their validation, theme checks, lock order
 * (the level's lock, then catalog item, theme row, `uiTheme` row) and audit apply, both settings in
 * one call and one transaction: a theme that cannot be set (`theme.not_available`) refuses the
 * whole call; a replacement that cannot be used where it is set is skipped, never refused (the
 * arrangement keeps unknown keys anyway). A dry run computes the same answer and writes nothing.
 */
@Injectable()
export class AppearanceService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(OrgSettingsService) private readonly orgSettings: OrgSettingsService,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
  ) {}

  /**
   * The suggestions of the live plugins named `names`, from the version their components come from
   * (`platform_synced_version`, else the latest); a plugin without one maps to null.
   */
  async suggestions(names: readonly string[]): Promise<Map<string, SuggestedAppearance | null>> {
    const out = new Map<string, SuggestedAppearance | null>(names.map((n) => [n, null]));
    if (names.length === 0) return out;
    const rows = await this.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", (j) =>
        j
          .onRef("v.item_id", "=", "i.id")
          .on((eb) =>
            eb("v.version", "=", eb.fn.coalesce("i.platform_synced_version", "i.latest_version")),
          ),
      )
      .select(["i.name", "v.manifest"])
      .where("i.name", "in", [...names])
      .where("i.deleted_at", "is", null)
      .execute();
    for (const r of rows) out.set(r.name, suggestedAppearanceOf(r.manifest));
    return out;
  }

  /** The live catalog item `itemId` with its suggestion; else `catalog.item_not_found`. */
  private async platformItem(itemId: string): Promise<SuggestingItem> {
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw itemNotFound();
    const row = await this.db
      .selectFrom("catalog_items")
      .select(["id", "name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const suggestion = row && (await this.suggestions([row.name])).get(row.name);
    if (!row || !suggestion) throw itemNotFound();
    return { id: row.id, name: row.name, suggestion };
  }

  /**
   * The live plugin of extension `extension`, which must be on in the org, with its suggestion;
   * else `extension.not_found`.
   */
  private async orgItem(orgId: string, extension: string): Promise<SuggestingItem> {
    if (!(await this.host.enabledPlugins(orgId)).has(extension)) throw extensionNotFound();
    const row = await this.db
      .selectFrom("catalog_items")
      .select(["id", "name"])
      .where("name", "=", extension)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const suggestion = row && (await this.suggestions([row.name])).get(row.name);
    if (!row || !suggestion) throw extensionNotFound();
    return { id: row.id, name: row.name, suggestion };
  }

  /**
   * Applies (or, with `dryRun`, previews) the suggestion of `item` at `level`: for the platform,
   * `item` is the catalog item id (`POST /api/v1/admin/catalog/items/:id/appearance`, super
   * admin); for an org, the extension name (`POST /api/v1/orgs/:orgId/extensions/:extension/
   * appearance`, `org.update`). The writers re-check the actor under their lock.
   */
  async apply(
    level: AppearanceLevel,
    item: string,
    actor: AppearanceActor,
    dryRun: boolean,
  ): Promise<AppearanceResult> {
    if (dryRun) {
      const found =
        "orgId" in level ? await this.orgItem(level.orgId, item) : await this.platformItem(item);
      const plan = await this.plan(level, found);
      if (plan.theme !== undefined) await this.assertThemeSettable(level, plan.theme);
      return plan.result;
    }
    return "orgId" in level
      ? this.applyOrg(level.orgId, item, actor)
      : this.applyPlatform(item, actor);
  }

  /** Refuses (`theme.not_available`) a theme the level's writer would refuse; reads only. */
  private async assertThemeSettable(level: AppearanceLevel, themeId: string): Promise<void> {
    if ("orgId" in level) {
      if (!(await themeOnIn(this.db.db, level.orgId, themeId))) {
        throw themeNotAvailable(themeId, "in this organization");
      }
    } else {
      await assertPlatformDefaultEligible(this.db.db, themeId);
    }
  }

  @Transactional()
  private async applyPlatform(itemId: string, actor: AppearanceActor): Promise<AppearanceResult> {
    // The writer's own lock first, so what the plan reads (the stored theme and arrangement) is
    // what the write replaces; the writer takes it again (re-entrant) and then the theme rows
    await this.adminLock.lockAndAuthorize(actor.accountId);
    const found = await this.platformItem(itemId);
    const plan = await this.plan({ platform: true }, found);
    if (plan.theme === undefined && Object.keys(plan.arrangement).length === 0) return plan.result;
    await this.settings.update(
      {
        ...(plan.theme !== undefined && { uiTheme: { id: plan.theme } }),
        ...(Object.keys(plan.arrangement).length > 0 && { uiArrangement: plan.arrangement }),
      },
      actor.accountId,
      actor.tokenId,
      { ...actor.auditDetail, appearance: { itemId: found.id, plugin: found.name } },
    );
    return plan.result;
  }

  @Transactional()
  private async applyOrg(
    orgId: string,
    extension: string,
    actor: AppearanceActor,
  ): Promise<AppearanceResult> {
    // The org lock first (as the writer takes it): `personal` and the stored arrangement are read
    // under it, so the write keeps the lock setting it read
    await this.orgLock.lockAndAuthorize(orgId, actor.accountId, "org.update");
    const found = await this.orgItem(orgId, extension);
    const plan = await this.plan({ orgId }, found);
    if (plan.theme === undefined && Object.keys(plan.arrangement).length === 0) return plan.result;
    const stored = await readOrgSettings(this.db.db, orgId);
    await this.orgSettings.update(
      orgId,
      {
        ...(plan.theme !== undefined && {
          theme: { id: plan.theme, personal: stored.theme?.personal ?? "allowed" },
        }),
        ...(Object.keys(plan.arrangement).length > 0 && { uiArrangement: plan.arrangement }),
      },
      actor.accountId,
      actor.tokenId,
      { ...actor.auditDetail, appearance: { itemId: found.id, plugin: found.name } },
    );
    return plan.result;
  }

  /** What applying `found` at `level` changes, from the level's stored settings (no writes). */
  private async plan(level: AppearanceLevel, found: SuggestingItem): Promise<AppearancePlan> {
    const { suggestion } = found;
    const [storedTheme, storedArrangement] =
      "orgId" in level
        ? await readOrgSettings(this.db.db, level.orgId).then(
            (s) => [s.theme?.id ?? null, s.uiArrangement ?? {}] as const,
          )
        : await Promise.all([
            readUiTheme(this.db.db).then((t) => t.id),
            readUiArrangement(this.db.db),
          ]);
    const result: AppearanceResult = { theme: null, replacements: [], skipped: [] };
    const plan: AppearancePlan = { result, arrangement: {} };

    if (suggestion.theme !== undefined) {
      const row = await this.db
        .selectFrom("platform_themes")
        .select("id")
        .where("catalog_item_id", "=", found.id)
        .where("name", "=", suggestion.theme)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!row) {
        throw themeNotAvailable(
          suggestion.theme,
          "orgId" in level ? "in this organization" : "as the platform default",
        );
      }
      if (row.id !== storedTheme) {
        plan.theme = row.id;
        result.theme = { from: storedTheme, to: row.id };
      }
    }

    // in the stored manifest's key order (a jsonb object: shorter keys first)
    const entries = Object.entries(suggestion.replacements ?? {});
    if (entries.length === 0) return plan;
    const enabled = "orgId" in level ? await this.host.enabledPlugins(level.orgId) : null;
    const loaded = this.host
      .uiContributions()
      .filter(
        (c) =>
          c.plugin === found.name &&
          c.contribution.aliasOf === undefined &&
          (enabled === null || enabled.has(c.plugin)),
      );
    const arrangeable = "orgId" in level ? ORG_ARRANGEABLE : UI_ARRANGEABLE_SLOTS;
    for (const [ref, id] of entries) {
      const parsed = parseSlotRef(ref);
      const known = parsed === null ? undefined : uiSlot(parsed.id);
      if (parsed === null || known === undefined || parsed.version > known.version) {
        result.skipped.push({ what: ref, reason: "unknown-slot" });
        continue;
      }
      const slot = known.id;
      if (known.cardinality !== "single" || !arrangeable.includes(slot)) {
        result.skipped.push({ what: ref, reason: "not-eligible" });
        continue;
      }
      const c = loaded.find((l) => l.slot.id === slot && l.contribution.id === id);
      if (c === undefined) {
        result.skipped.push({ what: ref, reason: "not-available" });
        continue;
      }
      if (c.contribution.kind !== "component") {
        result.skipped.push({ what: ref, reason: "not-eligible" });
        continue;
      }
      const key = `${found.name}/${id}`;
      const from = useOf((storedArrangement as UiArrangement)[slot]);
      if (from === key) continue;
      plan.arrangement[slot] = { use: key };
      result.replacements.push({ slot, from, to: key });
    }
    return plan;
  }
}

/**
 * The suggested appearance action: its own module, since it writes through the org settings
 * writer (`OrgsModule`, which imports `CatalogModule`) and the deployment settings writer.
 */
@Module({
  imports: [IdentityModule, OrgsModule, SuperAdminLockModule, OrgLockModule, ExtensionsModule],
  providers: [AppearanceService],
  exports: [AppearanceService],
})
export class AppearanceModule {}
