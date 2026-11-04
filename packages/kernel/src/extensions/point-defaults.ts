import { EXTENSION_POINTS } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { enabledExtensionsQuery, isExtensionEnabled } from "./enabled.js";
import { OrgExtensionConfigs } from "./org-config.js";
import { ExtensionRegistry } from "./registry.js";

/** The outcome of {@link ExtensionPointDefaults.resolve}. */
export type PointResolution<T> =
  | { ok: true; extension: string; impl: T; orgConfig: unknown }
  | { ok: false; reason: "none" | "ambiguous" };

/** One `org-default` extension point of an org (the admin view). */
export interface OrgPointDefaultView {
  point: string;
  /** The extensions that could serve the org now, by name. */
  candidates: string[];
  /** The stored default, also when it is not a candidate now. */
  default: string | null;
  /** The extension a call would use now; null when there is none or the choice is ambiguous. */
  effective: string | null;
}

interface Candidate {
  extension: string;
  impl: unknown;
  orgConfig: unknown;
}

/** The extension points whose provider each org chooses (`selection: "org-default"`). */
function selectionPoints(): string[] {
  return Object.entries(EXTENSION_POINTS)
    .filter(([, info]) => info.selection === "org-default")
    .map(([name]) => name);
}

const hasSelection = (point: string): boolean =>
  EXTENSION_POINTS[point]?.selection === "org-default";

/**
 * The org default provider of an `org-default` extension point (web tools spec §6). Per call,
 * never cached in process: the candidates are the providers loaded on this replica that are
 * enabled in the org, whose org config is valid and whose `configured()` (when present) does not
 * return false. One candidate is used as is; several need the org's stored default
 * (`capybara.org_extension_point_defaults`), else the choice is ambiguous. A stored default that
 * is not a candidate (disabled, uninstalled, unconfigured) stays and counts again once it is one.
 */
@Injectable()
export class ExtensionPointDefaults {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    @Inject(OrgExtensionConfigs) private readonly orgConfigs: Pick<OrgExtensionConfigs, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /**
   * The provider of `point` (the name without the major, e.g. `web-search`) for `orgId`, with the
   * org's decrypted config to pass back to it. Throws when the point has no `selection`.
   */
  async resolve<T>(orgId: string, point: string): Promise<PointResolution<T>> {
    if (!hasSelection(point)) {
      throw new Error(`extension point ${point} has no org-default selection`);
    }
    const candidates = await this.candidates(orgId, point);
    const chosen = await this.choose(orgId, point, candidates);
    if (!chosen.ok) return chosen;
    const c = chosen.candidate;
    return { ok: true, extension: c.extension, impl: c.impl as T, orgConfig: c.orgConfig };
  }

  /** Every `org-default` point with its candidates, stored default and effective provider. */
  async list(orgId: string): Promise<OrgPointDefaultView[]> {
    const stored = await this.storedDefaults(orgId);
    const out: OrgPointDefaultView[] = [];
    for (const point of selectionPoints()) {
      const candidates = await this.candidates(orgId, point);
      const chosen = pick(candidates, stored.get(point));
      out.push({
        point,
        candidates: candidates.map((c) => c.extension),
        default: stored.get(point) ?? null,
        effective: chosen.ok ? chosen.candidate.extension : null,
      });
    }
    return out;
  }

  /** Whether each `org-default` point has a provider for the org now (no extension names). */
  async available(orgId: string): Promise<{ point: string; available: boolean }[]> {
    const out: { point: string; available: boolean }[] = [];
    for (const point of selectionPoints()) {
      out.push({ point, available: (await this.resolve(orgId, point)).ok });
    }
    return out;
  }

  /**
   * Stores `extension` as the org's default provider of `point`. 400 `validation_failed` unless
   * the point is an `org-default` one and the extension provides it (loaded here) and is enabled
   * in the org. Audited as `extension_point.default_set`.
   */
  @Transactional()
  async setDefault(
    orgId: string,
    point: string,
    extension: string,
    actorId: string,
  ): Promise<void> {
    const db = this.kdb.db;
    if (!hasSelection(point)) {
      throw new ApiError(
        "validation_failed",
        `${point} is not an extension point with an organization default`,
      );
    }
    const provides = this.registry.list(point).some((e) => e.plugin === extension);
    if (!provides || !(await isExtensionEnabled(db, orgId, extension))) {
      throw new ApiError(
        "validation_failed",
        `Extension ${extension} does not provide ${point} or is not enabled in this organization`,
      );
    }
    await db
      .insertInto("org_extension_point_defaults")
      .values({ org_id: orgId, point, extension, updated_by: actorId })
      .onConflict((oc) =>
        oc.columns(["org_id", "point"]).doUpdateSet({
          extension,
          updated_by: actorId,
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(db, {
      actorAccountId: actorId,
      orgId,
      action: "extension_point.default_set",
      target: point,
      detail: { point, extension },
    });
  }

  /** The candidates of `point` in `orgId`, by extension name. */
  private async candidates(orgId: string, point: string): Promise<Candidate[]> {
    const db = this.kdb.db;
    const enabled = new Set(
      (
        await db
          .selectFrom(enabledExtensionsQuery(db, orgId).as("en"))
          .select("en.plugin")
          .execute()
      ).map((r) => r.plugin),
    );
    const providers = new Map<string, unknown>();
    for (const e of this.registry.list(point)) {
      if (enabled.has(e.plugin) && !providers.has(e.plugin)) providers.set(e.plugin, e.impl);
    }
    const out: Candidate[] = [];
    for (const [extension, impl] of providers) {
      let cfg: { enabled: boolean; config: unknown } | undefined;
      try {
        cfg = await this.orgConfigs.get(orgId, extension);
      } catch (err) {
        this.log.warn("org default provider: provider excluded, its org config is invalid", {
          orgId,
          point,
          extension,
          err,
        });
        continue;
      }
      if (!cfg?.enabled) continue;
      const configured = (impl as { configured?: (orgConfig: unknown) => boolean }).configured;
      if (typeof configured === "function") {
        let ok: boolean;
        try {
          ok = configured.call(impl, cfg.config) !== false;
        } catch (err) {
          this.log.warn("org default provider: provider excluded, configured() threw", {
            orgId,
            point,
            extension,
            err,
          });
          continue;
        }
        if (!ok) continue;
      }
      out.push({ extension, impl, orgConfig: cfg.config });
    }
    return out.sort((a, b) => (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0));
  }

  private async choose(
    orgId: string,
    point: string,
    candidates: Candidate[],
  ): Promise<{ ok: true; candidate: Candidate } | { ok: false; reason: "none" | "ambiguous" }> {
    if (candidates.length < 2) return pick(candidates, undefined);
    return pick(candidates, (await this.storedDefaults(orgId)).get(point));
  }

  /** The org's stored defaults, point → extension. */
  private async storedDefaults(orgId: string): Promise<Map<string, string>> {
    const rows = await this.kdb.db
      .selectFrom("org_extension_point_defaults")
      .select(["point", "extension"])
      .where("org_id", "=", orgId)
      .execute();
    return new Map(rows.map((r) => [r.point, r.extension]));
  }
}

/** Rules 2-4 of spec §6: one candidate → it; several → the stored default if a candidate. */
function pick(
  candidates: Candidate[],
  stored: string | undefined,
): { ok: true; candidate: Candidate } | { ok: false; reason: "none" | "ambiguous" } {
  const [only] = candidates;
  if (only === undefined) return { ok: false, reason: "none" };
  if (candidates.length === 1) return { ok: true, candidate: only };
  const chosen = candidates.find((c) => c.extension === stored);
  return chosen ? { ok: true, candidate: chosen } : { ok: false, reason: "ambiguous" };
}
