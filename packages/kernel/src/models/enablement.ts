import { Inject, Injectable, Module } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry, ExtensionRegistryModule } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock, SuperAdminLockModule } from "../identity/super-admin.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable, CacheEvict } from "../infra/cache/cacheable.decorator.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock, OrgLockModule } from "../orgs/org-lock.js";

/** The key of a model in a disabled set: `provider\u0000model`. */
export const modelKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/** How long a disabled list stays cached (s); every write evicts it after its commit. */
const DISABLED_TTL_SECONDS = 300;
/** The cache key of a scope's disabled list (`platform` or `org.<id>`). */
const PLATFORM_SCOPE = "platform";
const orgScope = (orgId: string) => `org.${orgId}`;

/** An agent whose current version uses a newly disabled model as its main model or fallback. */
export interface AffectedModelAgent {
  id: string;
  name: string;
  orgId: string;
}

/** A purpose mapping targeting a newly disabled model: a deployment default (`orgId` null) or an org override. */
export interface AffectedModelPurpose {
  purpose: string;
  orgId: string | null;
}

/** The result of a disabled-list write: what now points at a model it disabled (spec B §5.3). */
export interface ModelDisableResult {
  affected: { agents: AffectedModelAgent[]; purposes: AffectedModelPurpose[] };
}

/**
 * A change to one layer's disabled list of a provider: ids to disable and ids to enable. An id in
 * neither list keeps its stored state; an id in both is refused.
 */
export interface ModelDisableChange {
  disable: string[];
  enable: string[];
}

/** The acting person of a write. */
export interface ModelDisableActor {
  accountId: string;
  tokenId?: string | undefined;
}

/**
 * Models disabled on two layers (spec B §5.3, table `model_disabled`): the platform's list (the
 * super admin; such a model is invisible to every org) and each org's (an org admin). Every model a
 * provider lists is enabled unless a layer disabled it; a row keys on the model id, so it applies to
 * whichever list the org sees, and an id the list does not contain is kept harmlessly. Disabling
 * never creates an org config copy.
 *
 * The lists are read from PG and cached in Redis (`@Cacheable`, evicted after the commit of each
 * write), never in process memory. `ProviderRegistry` filters its lists and `resolve` with them;
 * purposes check their targets with {@link isEnabled}.
 */
@Injectable()
export class ModelEnablement {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "list">,
    @Inject(SuperAdminLock) private readonly adminLock: Pick<SuperAdminLock, "lockAndAuthorize">,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** One layer's disabled models (keys {@link modelKey}): the platform's (`null`) or the org's own. */
  async disabled(orgId: string | null): Promise<Set<string>> {
    return new Set(await this.disabledKeys(orgId === null ? PLATFORM_SCOPE : orgScope(orgId)));
  }

  @Cacheable({ key: "capk:model-disabled:#{0}", ttl: DISABLED_TTL_SECONDS })
  private async disabledKeys(scope: string): Promise<string[]> {
    const orgId = scope === PLATFORM_SCOPE ? null : scope.slice("org.".length);
    const rows = await this.rowsOf(orgId);
    return rows.map((r) => modelKey(r.provider, r.model)).sort();
  }

  private rowsOf(orgId: string | null, provider?: string) {
    let q = this.db
      .selectFrom("model_disabled")
      .select(["provider", "model"])
      .where((eb) => (orgId === null ? eb("org_id", "is", null) : eb("org_id", "=", orgId)));
    if (provider !== undefined) q = q.where("provider", "=", provider);
    return q.execute();
  }

  /**
   * The extensions `orgId` explicitly turned off: a row of the org's own switch
   * (`extension_org_configs.enabled = false`, what the org's extension or plugin switch writes when
   * an org admin turns it off), never a required bootstrap plugin. An extension with no row for the
   * org is not in the set (it keeps working as before: spec A §8 with B's no-breakage anti-goal).
   * Read from PG on every call (one small query; the switch has its own writers, nothing to evict).
   */
  async switchedOff(orgId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom("extension_org_configs as eoc")
      .leftJoin("extension_installs as ri", (j) =>
        j.onRef("ri.name", "=", "eoc.plugin").on("ri.required", "=", true),
      )
      .select("eoc.plugin")
      .where("eoc.org_id", "=", orgId)
      .where("eoc.enabled", "=", false)
      .where("ri.name", "is", null)
      .execute();
    return new Set(rows.map((r) => r.plugin));
  }

  /** Whether neither the platform nor `orgId` disabled the model (the lists only; see the class). */
  async isEnabled(orgId: string, provider: string, model: string): Promise<boolean> {
    const key = modelKey(provider, model);
    const [platform, org] = await Promise.all([this.disabled(null), this.disabled(orgId)]);
    return !platform.has(key) && !org.has(key);
  }

  /**
   * Changes the platform's disabled ids of `provider` by `change` (super admin, re-checked under
   * the lock): ids in neither list keep their stored state. Returns what now points at a newly
   * disabled model, across orgs.
   */
  @Transactional()
  @CacheEvict({ key: `capk:model-disabled:${PLATFORM_SCOPE}` })
  async setPlatform(
    provider: string,
    change: ModelDisableChange,
    actor: ModelDisableActor,
  ): Promise<ModelDisableResult> {
    await this.adminLock.lockAndAuthorize(actor.accountId);
    return this.apply(null, provider, change, actor);
  }

  /**
   * Changes the org's disabled ids of `provider` by `change` (`org.models.manage`, re-checked under
   * the org lock): ids in neither list keep their stored state, so rows for models the org's page
   * does not show (platform-disabled, or no longer listed) survive. Returns what in the org now
   * points at a newly disabled model (its agents, its overrides and the deployment defaults it uses).
   */
  @Transactional()
  @CacheEvict({ key: "capk:model-disabled:org.#{0}" })
  async setOrg(
    orgId: string,
    provider: string,
    change: ModelDisableChange,
    actor: ModelDisableActor,
  ): Promise<ModelDisableResult> {
    await this.orgLock.lockAndAuthorize(orgId, actor.accountId, "org.models.manage");
    return this.apply(orgId, provider, change, actor);
  }

  private async apply(
    orgId: string | null,
    provider: string,
    change: ModelDisableChange,
    actor: ModelDisableActor,
  ): Promise<ModelDisableResult> {
    if (!this.extensions.list("model-provider").some((e) => e.plugin === provider)) {
      throw new ApiError("model.provider_not_found", `Model provider ${provider} is not installed`);
    }
    const disable = new Set(change.disable);
    const both = change.enable.filter((m) => disable.has(m));
    if (both.length > 0) {
      throw new ApiError(
        "validation_failed",
        `A model cannot be both disabled and enabled: ${[...new Set(both)].join(", ")}`,
      );
    }
    const had = new Set((await this.rowsOf(orgId, provider)).map((r) => r.model));
    const added = [...disable].filter((m) => !had.has(m)).sort();
    const removed = [...new Set(change.enable)].filter((m) => had.has(m)).sort();
    if (removed.length > 0) {
      await this.db
        .deleteFrom("model_disabled")
        .where((eb) => (orgId === null ? eb("org_id", "is", null) : eb("org_id", "=", orgId)))
        .where("provider", "=", provider)
        .where("model", "in", removed)
        .execute();
    }
    if (added.length > 0) {
      await this.db
        .insertInto("model_disabled")
        .values(
          added.map((model) => ({
            org_id: orgId,
            provider,
            model,
            disabled_by: actor.accountId,
          })),
        )
        .execute();
    }
    if (added.length > 0 || removed.length > 0) {
      await audit(this.db, {
        actorAccountId: actor.accountId,
        ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
        ...(orgId !== null && { orgId }),
        action: orgId === null ? "model.disabled_set" : "org.model_disabled_set",
        target: provider,
        detail: {
          scope: orgId === null ? "platform" : "org",
          disabled: added,
          enabled: removed,
        },
      });
    }
    return {
      affected: {
        agents: await this.agentsUsing(orgId, provider, added),
        purposes: await this.purposesUsing(orgId, provider, added),
      },
    };
  }

  /** Live agents (of `orgId`, or of every org) whose current version uses one of `models`. */
  private async agentsUsing(
    orgId: string | null,
    provider: string,
    models: string[],
  ): Promise<AffectedModelAgent[]> {
    if (models.length === 0) return [];
    const wanted = new Set(models);
    let q = this.db
      .selectFrom("agents as a")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .select(["a.id", "a.org_id", "v.definition"])
      .where("a.deleted_at", "is", null)
      .orderBy("a.org_id")
      .orderBy("a.id");
    if (orgId !== null) q = q.where("a.org_id", "=", orgId);
    const out: AffectedModelAgent[] = [];
    for (const r of await q.execute()) {
      const def = r.definition as { name?: unknown; model?: unknown; fallback?: unknown } | null;
      const uses = [def?.model, def?.fallback].some((x) => {
        const ref = x as { provider?: unknown; model?: unknown } | null | undefined;
        return ref?.provider === provider && typeof ref.model === "string" && wanted.has(ref.model);
      });
      if (uses) {
        out.push({
          id: r.id,
          name: typeof def?.name === "string" ? def.name : r.id,
          orgId: r.org_id,
        });
      }
    }
    return out;
  }

  /**
   * Purpose mappings targeting one of `models`: for the platform every default and override, for
   * an org its overrides and the deployment defaults (an org that disabled a default's model has
   * that purpose unconfigured).
   */
  private async purposesUsing(
    orgId: string | null,
    provider: string,
    models: string[],
  ): Promise<AffectedModelPurpose[]> {
    if (models.length === 0) return [];
    let q = this.db
      .selectFrom("model_purpose_mappings")
      .select(["purpose", "org_id"])
      .where("provider", "=", provider)
      .where("model", "in", models)
      .orderBy("purpose")
      .orderBy("org_id", (ob) => ob.nullsFirst());
    if (orgId === null) {
      return (await q.execute()).map((r) => ({ purpose: r.purpose, orgId: r.org_id }));
    }
    q = q.where((eb) => eb.or([eb("org_id", "is", null), eb("org_id", "=", orgId)]));
    const rows = await q.execute();
    // a default the org overrides is not what the org uses
    const overridden = new Set(
      (
        await this.db
          .selectFrom("model_purpose_mappings")
          .select("purpose")
          .where("org_id", "=", orgId)
          .execute()
      ).map((r) => r.purpose),
    );
    return rows
      .filter((r) => r.org_id !== null || !overridden.has(r.purpose))
      .map((r) => ({ purpose: r.purpose, orgId: r.org_id }));
  }
}

/** The one {@link ModelEnablement}: the provider registry, purposes and the controllers read it. */
@Module({
  imports: [ExtensionRegistryModule, SuperAdminLockModule, OrgLockModule],
  providers: [ModelEnablement],
  exports: [ModelEnablement],
})
export class ModelEnablementModule {}
