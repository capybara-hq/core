import type { LocalizedName, PluginExtensionSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { ExtensionDisplayNames } from "./display-name.js";
import { SingleProviderLock } from "./locks.js";
import { ExtensionRegistry } from "./registry.js";
import { electSingleProviders, singlePointsOf } from "./resolve.js";

/** The error code of an enable refused because another extension provides the same single point. */
export const SINGLE_PROVIDER_ENABLED = "extension.single_provider_enabled";

/**
 * The error code of an enable refused because a required bootstrap plugin provides the same single
 * point: a required plugin cannot be disabled, so nothing can replace it. A code of its own (not
 * {@link SINGLE_PROVIDER_ENABLED} with a flag) because the next step differs: there is none, while
 * {@link SINGLE_PROVIDER_ENABLED} says to disable the other one first; the web, the CLI and the
 * Platform tool key their text on the code.
 */
export const SINGLE_PROVIDER_REQUIRED = "extension.single_provider_required";

/** Either single-provider refusal code. */
export const isSingleProviderCode = (code: string): boolean =>
  code === SINGLE_PROVIDER_ENABLED || code === SINGLE_PROVIDER_REQUIRED;

/**
 * What keeps an extension from being enabled: the point and the enabled extension providing it
 * (`required`: a required bootstrap plugin, which cannot be disabled).
 */
export interface SingleProviderBlock {
  extensionPoint: string;
  enabled: { name: string; displayName: LocalizedName | null };
  required?: true;
}

/**
 * An extension left disabled by an install or import path because a single-provider point it
 * provides is taken: the refusal's code and message and the block (as in the 409's details).
 */
export interface SingleProviderNote {
  code: string;
  message: string;
  singleProvider: SingleProviderBlock;
}

/** The English message of the refusal ({@link SINGLE_PROVIDER_ENABLED} / {@link SINGLE_PROVIDER_REQUIRED}). */
export function singleProviderMessage(
  block: SingleProviderBlock,
  name: string,
  displayName: LocalizedName | null,
): string {
  const other = block.enabled.displayName?.en ?? block.enabled.name;
  if (block.required === true) {
    return `${block.extensionPoint} is provided by the required plugin ${other}; it can't be replaced`;
  }
  const self = displayName?.en ?? name;
  return `Only one extension may provide ${block.extensionPoint}; disable ${other} first, then enable ${self}`;
}

/** The 409 refusal, details `[{ extensionPoint, enabled, required? }]`. */
export function singleProviderError(
  block: SingleProviderBlock,
  name: string,
  displayName: LocalizedName | null,
): ApiError {
  return new ApiError(
    block.required === true ? SINGLE_PROVIDER_REQUIRED : SINGLE_PROVIDER_ENABLED,
    singleProviderMessage(block, name, displayName),
    [block],
  );
}

/** The note of a refusal ({@link singleProviderError}) an install path reports instead of failing. */
export function singleProviderNote(refusal: ApiError): SingleProviderNote {
  return {
    code: refusal.code,
    message: refusal.message,
    singleProvider: refusal.details?.[0] as SingleProviderBlock,
  };
}

/**
 * The single-provider rule of the deployment (maintainer decision 2026-11-08): a single-provider
 * extension point has at most one enabled provider. Enabling a second one is refused (409
 * {@link SINGLE_PROVIDER_ENABLED}); to switch, the super admin disables the current one first. A
 * required bootstrap plugin cannot be disabled, so a point it holds cannot change provider (409
 * {@link SINGLE_PROVIDER_REQUIRED}). An upgrade that newly provides a held point installs the new
 * version disabled (`ExtensionAdminOps.install`, `leftDisabled`).
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
   * The first single-provider point of `provides` that an extension other than `name` holds, or
   * null: a config-declared extension loaded here, else the winner of the single-provider election
   * ({@link electSingleProviders}, the host's) over the other enabled install records, so the
   * extension named is the one actually loaded (a loser of the election holds nothing). A read
   * without locks: views and prechecks use it; the enable itself uses {@link assertFree}.
   */
  async occupant(name: string, provides: readonly string[]): Promise<SingleProviderBlock | null> {
    const points = singlePointsOf(provides);
    if (points.length === 0) return null;
    const declared = this.registry
      .all()
      .filter((i) => i.source === "config" && i.name !== name)
      .map((i) => ({ name: i.name, provides: i.manifest.provides as readonly string[] }));
    const declaredNames = new Set(this.registry.declared().keys());
    const rows = await this.kdb.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.name",
        "extension_installs.required",
        "extension_packages.section",
      ])
      .where("extension_installs.desired_state", "=", "enabled")
      .where("extension_installs.name", "<>", name)
      // ExtensionInstalls.desired's order: the election's
      .orderBy(sql`extension_installs.enabled_at ASC NULLS LAST`)
      .orderBy("extension_installs.installed_at")
      .orderBy("extension_installs.name")
      .execute();
    const installs = rows
      .filter((r) => !declaredNames.has(r.name))
      .map((r) => ({
        name: r.name,
        required: r.required,
        section: {
          manifest: {
            provides: (r.section as PluginExtensionSection | null)?.manifest?.provides ?? [],
          },
        },
      }));
    const { owners } = electSingleProviders(installs);
    for (const extensionPoint of points) {
      const config = declared.find((o) => o.provides.includes(extensionPoint));
      const holder = config?.name ?? owners.get(extensionPoint);
      if (holder === undefined) continue;
      const required = config === undefined && installs.find((i) => i.name === holder)?.required;
      return {
        extensionPoint,
        enabled: { name: holder, displayName: await this.displayNames.get(holder) },
        ...(required === true && { required: true as const }),
      };
    }
    return null;
  }

  /**
   * The occupant ({@link occupant}) of `name`'s single-provider points among `provides`, read
   * after taking one transaction-scoped lock per point ({@link SingleProviderLock}, sorted) in the
   * caller's transaction (after its install lock), so two concurrent writes enabling providers of
   * one point run one after the other and the second sees the first's committed state.
   */
  @Transactional({ propagation: "mandatory" })
  async lockedOccupant(
    name: string,
    provides: readonly string[],
  ): Promise<SingleProviderBlock | null> {
    const points = singlePointsOf(provides);
    if (points.length === 0) return null;
    for (const p of points) await this.pointLock.lock(p);
    return this.occupant(name, points);
  }

  /** The note of `name` left disabled by `block` (the refusal's code, message and block). */
  async note(block: SingleProviderBlock, name: string): Promise<SingleProviderNote> {
    return singleProviderNote(singleProviderError(block, name, await this.displayNames.get(name)));
  }

  /**
   * Refuses (409 {@link SINGLE_PROVIDER_ENABLED}, or {@link SINGLE_PROVIDER_REQUIRED} when the
   * holder is a required plugin) to enable `name` while another extension holds one of its
   * single-provider points; under the points' locks ({@link lockedOccupant}).
   */
  @Transactional({ propagation: "mandatory" })
  async assertFree(name: string, provides: readonly string[]): Promise<void> {
    const block = await this.lockedOccupant(name, provides);
    if (block) throw singleProviderError(block, name, await this.displayNames.get(name));
  }
}
