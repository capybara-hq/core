import type { LocalizedName, PluginExtensionSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { ExtensionDisplayNames } from "./display-name.js";
import { SingleProviderLock } from "./locks.js";
import { ExtensionRegistry } from "./registry.js";
import { singlePointsOf } from "./resolve.js";

/** The error code of an enable refused because another extension provides the same single point. */
export const SINGLE_PROVIDER_ENABLED = "extension.single_provider_enabled";

/** What keeps an extension from being enabled: the point and the enabled extension providing it. */
export interface SingleProviderBlock {
  extensionPoint: string;
  enabled: { name: string; displayName: LocalizedName | null };
}

/** The English message of {@link SINGLE_PROVIDER_ENABLED}. */
export function singleProviderMessage(
  block: SingleProviderBlock,
  name: string,
  displayName: LocalizedName | null,
): string {
  const other = block.enabled.displayName?.en ?? block.enabled.name;
  const self = displayName?.en ?? name;
  return `Only one extension may provide ${block.extensionPoint}; disable ${other} first, then enable ${self}`;
}

/** The 409 {@link SINGLE_PROVIDER_ENABLED} error, details `[{ extensionPoint, enabled }]`. */
export function singleProviderError(
  block: SingleProviderBlock,
  name: string,
  displayName: LocalizedName | null,
): ApiError {
  return new ApiError(SINGLE_PROVIDER_ENABLED, singleProviderMessage(block, name, displayName), [
    { extensionPoint: block.extensionPoint, enabled: block.enabled },
  ]);
}

/**
 * The single-provider rule of the deployment (maintainer decision 2026-11-08): a single-provider
 * extension point has at most one enabled provider. Enabling a second one is refused (409
 * {@link SINGLE_PROVIDER_ENABLED}); to switch, the super admin disables the current one first.
 * Every path that sets an install record's desired state to `enabled` goes through
 * `ExtensionAdminOps.enable`, which calls {@link assertFree} in its transaction; install and import
 * paths that would enable call it through `enableUnlessOccupied` and leave the extension disabled
 * when the point is taken. Stateless.
 */
@Injectable()
export class SingleProviderGuard {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SingleProviderLock) private readonly pointLock: SingleProviderLock,
    /** Config-declared extensions loaded on this replica (empty in the CLI: install records only). */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
  ) {}

  /**
   * The first single-provider point of `provides` that an extension other than `name` already
   * provides while enabled (an install record desired `enabled`, or a config-declared extension
   * loaded here), or null. A read without locks: views and prechecks use it; the enable itself
   * uses {@link assertFree}.
   */
  async occupant(name: string, provides: readonly string[]): Promise<SingleProviderBlock | null> {
    const points = singlePointsOf(provides);
    if (points.length === 0) return null;
    const rows = await this.kdb.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select(["extension_installs.name", "extension_packages.section"])
      .where("extension_installs.desired_state", "=", "enabled")
      .where("extension_installs.name", "<>", name)
      // the earliest enabled first: the one the host loads (see ExtensionInstalls.desired)
      .orderBy("extension_installs.enabled_at")
      .orderBy("extension_installs.installed_at")
      .orderBy("extension_installs.name")
      .execute();
    const others: { name: string; provides: readonly string[] }[] = [
      ...this.registry
        .all()
        .filter((i) => i.source === "config" && i.name !== name)
        .map((i) => ({ name: i.name, provides: i.manifest.provides })),
      ...rows.map((r) => ({
        name: r.name,
        provides: (r.section as PluginExtensionSection | null)?.manifest?.provides ?? [],
      })),
    ];
    for (const extensionPoint of points) {
      const other = others.find((o) => o.provides.includes(extensionPoint));
      if (other) {
        return {
          extensionPoint,
          enabled: { name: other.name, displayName: await this.displayNames.get(other.name) },
        };
      }
    }
    return null;
  }

  /**
   * Refuses (409 {@link SINGLE_PROVIDER_ENABLED}) to enable `name` while another extension
   * provides one of its single-provider points enabled. Joins the enable's transaction and first
   * takes one transaction-scoped lock per point ({@link SingleProviderLock}, sorted), so two
   * concurrent enables of different providers of one point run one after the other and the second
   * sees the first's committed state.
   */
  @Transactional({ propagation: "mandatory" })
  async assertFree(name: string, provides: readonly string[]): Promise<void> {
    const points = singlePointsOf(provides);
    if (points.length === 0) return;
    for (const p of points) await this.pointLock.lock(p);
    const block = await this.occupant(name, points);
    if (block) throw singleProviderError(block, name, await this.displayNames.get(name));
  }
}
