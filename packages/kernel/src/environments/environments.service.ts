import { randomUUID } from "node:crypto";
import type { LocalizedName, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxJobs } from "../sandbox/jobs.js";
import { SandboxProviders } from "../sandbox/providers.js";
import { environmentNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import {
  EnvironmentAccess,
  environmentProvider,
  environmentUnavailable,
  holdsResources,
  type ProviderFacts,
} from "./access.js";

/** An environment as its owner sees it (`GET /orgs/:orgId/environments`). */
export interface EnvironmentView {
  id: string;
  /**
   * null for the default environment (shown as 「个人环境」 / "Personal") and for a demoted default
   * (shown as 「个人环境（Docker 沙箱）」 / "Personal (Docker sandbox)", from {@link demotedFrom}).
   */
  name: string | null;
  isDefault: boolean;
  /**
   * A former default demoted by a sandbox provider switch (spec §4.2 item 13): the provider it was
   * demoted from, that extension's display name (null when it has none, e.g. uninstalled: show the
   * id), and its place among the person's unnamed former defaults of that provider (1, 2, … by
   * creation; a label shows " 2", " 3", … after the first). Switching back to that provider makes
   * it the default again. null for every other environment.
   */
  demotedFrom: { provider: string; displayName: LocalizedName | null; ordinal: number } | null;
  ownerKind: "personal";
  source: "cloud";
  /** The provider keeping its files, or the one its first use will create them with. */
  provider: string | null;
  /** Its provider is the deployment's current sandbox provider. */
  available: boolean;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /** The org's effective sandbox limits (phase 1 environments use them unchanged, spec §8.4). */
  limits: SandboxLimits;
  createdAt: string;
}

/** The list response: the person's live environments in the org. */
export interface EnvironmentList {
  items: EnvironmentView[];
  /** The person's default environment; null when there is none (no sandbox provider to make it). */
  defaultId: string | null;
  /** The environment of the person's most recently updated conversation that has a live one. */
  lastUsedId: string | null;
  /** There is a current sandbox provider (new cloud environments can be made; ruling R4). */
  cloudAvailable: boolean;
}

const isUniqueViolation = (e: unknown, constraint: string): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === constraint;

const nameTaken = (): ApiError =>
  new ApiError("environment.name_taken", "You already have an environment with this name");

/**
 * Personal cloud environments (spec 2026-11-07-environments-design §4.2 items 7, 12, 13; §9): a
 * person's environments in an org, visible and usable only by their owner (anyone else gets
 * `environment.not_found`). Deleting one soft-deletes it and destroys its instance and files in a
 * `sandbox-destroy-for` job after the commit.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(SandboxProviders) private readonly providers: Pick<SandboxProviders, "current">,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "orgLimits">,
    @Inject(SandboxJobs) private readonly sandboxJobs: Pick<SandboxJobs, "destroy" | "resetFiles">,
    @Inject(EnvironmentAccess) private readonly access: Pick<EnvironmentAccess, "usable">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * The person's live environments in the org, the default first, then by creation. With a
   * current sandbox provider the default environment is created first if missing (its first need,
   * spec §4.2 item 7; an existing one is only read).
   */
  async list(orgId: string, accountId: string): Promise<EnvironmentList> {
    const cloudAvailable = this.providers.current() !== undefined;
    const defaultId = cloudAvailable ? await this.ensureDefault(orgId, accountId) : null;
    const items = await this.views(orgId, accountId);
    const last = await this.db
      .selectFrom("conversations as c")
      .innerJoin("environments as e", "e.id", "c.environment_id")
      .select("c.environment_id")
      .where("c.org_id", "=", orgId)
      .where("c.account_id", "=", accountId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .orderBy("c.updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return {
      items,
      defaultId: defaultId ?? items.find((v) => v.isDefault)?.id ?? null,
      lastUsedId: last?.environment_id ?? null,
      cloudAvailable,
    };
  }

  /** One of the person's live environments; anyone else's (or a missing one) → `not_found`. */
  async get(orgId: string, accountId: string, id: string): Promise<EnvironmentView> {
    const [view] = await this.views(orgId, accountId, id);
    if (!view) throw environmentNotFound();
    return view;
  }

  /**
   * A new personal cloud environment, ready at once (its instance and files are made on first
   * use). Needs a current sandbox provider (`environment.unavailable`); a live name of the person's
   * (case-insensitive) → `environment.name_taken`; `environments.maxPersonal` live ones (the
   * default counts) → `environment.limit_reached`. Serialized per person by their membership row.
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<EnvironmentView> {
    const id = await this.insert(orgId, accountId, input.name, actorTokenId, auditDetail);
    return this.get(orgId, accountId, id);
  }

  @Transactional()
  private async insert(
    orgId: string,
    accountId: string,
    name: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ): Promise<string> {
    const current = this.providers.current();
    if (!current) throw environmentUnavailable(null);
    await this.lockMember(orgId, accountId);
    const { n } = await this.db
      .selectFrom("environments")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const max = this.config.get().environments.maxPersonal;
    if (Number(n) >= max) {
      throw new ApiError(
        "environment.limit_reached",
        `You already have ${max} environments in this organization; delete one to create another`,
      );
    }
    await this.assertNameFree(orgId, accountId, name);
    const id = randomUUID();
    try {
      await this.db
        .insertInto("environments")
        .values({
          id,
          org_id: orgId,
          owner_kind: "personal",
          owner_account_id: accountId,
          name,
          source: "cloud",
          provider: current.plugin,
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "environments_name_uq")) throw nameTaken();
      throw e;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "environment.created",
      target: id,
      detail: { name, ...auditDetail },
    });
    return id;
  }

  /**
   * The refusals {@link create} would raise, read without locks or writes (a precheck before a
   * confirmation card): no sandbox provider, the person's limit, a name already taken. Throws the
   * same {@link ApiError}s; a race still ends in `create`'s own refusal.
   */
  async checkCreate(orgId: string, accountId: string, name: string): Promise<void> {
    if (!this.providers.current()) throw environmentUnavailable(null);
    const { n } = await this.db
      .selectFrom("environments")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const max = this.config.get().environments.maxPersonal;
    if (Number(n) >= max) {
      throw new ApiError(
        "environment.limit_reached",
        `You already have ${max} environments in this organization; delete one to create another`,
      );
    }
    await this.assertNameFree(orgId, accountId, name);
  }

  /** How many of the person's conversations work in the environment (read only). */
  async boundConversations(orgId: string, accountId: string, id: string): Promise<number> {
    const { n } = await this.db
      .selectFrom("conversations")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("environment_id", "=", id)
      .executeTakeFirstOrThrow();
    return Number(n);
  }

  /** The refusals {@link resetFiles} would raise (not found, its provider not current), read only. */
  async checkReset(orgId: string, accountId: string, id: string): Promise<void> {
    await this.access.usable(orgId, accountId, id);
  }

  /** The refusals {@link rename} would raise, read without locks (see {@link checkCreate}). */
  async checkRename(orgId: string, accountId: string, id: string, name: string): Promise<void> {
    const before = await this.get(orgId, accountId, id);
    if (before.name?.toLowerCase() !== name.toLowerCase()) {
      await this.assertNameFree(orgId, accountId, name);
    }
  }

  /**
   * Renames one of the person's live environments (the default too); see {@link create}. A
   * renamed former default is the person's own from then on: it loses its demotion mark, so a
   * switch back to its provider no longer restores it.
   */
  async rename(
    orgId: string,
    accountId: string,
    id: string,
    name: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<EnvironmentView> {
    await this.renameIn(orgId, accountId, id, name, actorTokenId, auditDetail);
    return this.get(orgId, accountId, id);
  }

  @Transactional()
  private async renameIn(
    orgId: string,
    accountId: string,
    id: string,
    name: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const before = await this.lockOwn(orgId, accountId, id);
    if (before.name === name) return;
    // the same name in another case is this environment's own: the index allows it
    if (before.name?.toLowerCase() !== name.toLowerCase()) {
      await this.assertNameFree(orgId, accountId, name);
    }
    try {
      await this.db
        .updateTable("environments")
        .set({ name, demoted_from_provider: null, updated_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "environments_name_uq")) throw nameTaken();
      throw e;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "environment.renamed",
      target: id,
      detail: { from: before.name, to: name, ...auditDetail },
    });
  }

  /**
   * Deletes one of the person's live environments: soft delete, its IM default row cleared, and
   * after the commit a `sandbox-destroy-for` job (the worker waits for running commands, then
   * destroys the instance and the files). Conversations bound to it keep pointing at it; their
   * sandbox tools then fail with `environment.not_found`.
   */
  @Transactional()
  async remove(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const before = await this.lockOwn(orgId, accountId, id);
    await this.db
      .updateTable("environments")
      .set({ deleted_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    await this.db
      .deleteFrom("environment_defaults")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("environment_id", "=", id)
      .execute();
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "environment.deleted",
      target: id,
      detail: { name: before.name, isDefault: before.is_default, ...auditDetail },
    });
    afterCommit(async () => {
      try {
        await this.sandboxJobs.destroy([id]);
      } catch (err) {
        // the hourly destruction sweep destroys deleted environments too
        this.log.warn("cannot schedule environment destruction", { environmentId: id, err });
      }
    });
  }

  /**
   * Starts one of the person's environments over with empty files (after
   * `environment.files_lost`): records the request (audit), then, after the commit, enqueues the
   * `sandbox-reset-files` job (deterministic id per environment), whose worker waits for running
   * commands and destroys any instance and the file system; the next use creates new ones. Its
   * provider must be the current one (`environment.unavailable`). An enqueue failure is thrown
   * (the request can be repeated: the reset is idempotent).
   */
  async resetFiles(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    await this.recordReset(orgId, accountId, id, actorTokenId, auditDetail);
    await this.sandboxJobs.resetFiles(id);
  }

  /** The check and audit row of {@link resetFiles}, committed before the job is enqueued. */
  @Transactional()
  private async recordReset(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    await this.access.usable(orgId, accountId, id);
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "environment.files_reset",
      target: id,
      ...(auditDetail !== undefined && { detail: auditDetail }),
    });
  }

  /**
   * The person's default environment in the org, created when missing (named by the UI, `name`
   * NULL). An existing usable one is read without locking. A live default whose files or
   * instance are kept by a provider that is not the current one (a provider switch, spec §4.2
   * item 13) is stranded: it is demoted (marked with the provider it was demoted from; the UI
   * names it 「个人环境（<provider display name>）」) and stays listed as unavailable and deletable.
   * Its replacement is the person's former default demoted from the current provider when there
   * is one (switching back restores it, with its files), else a fresh default. A live default
   * that holds no files yet is likewise swapped for a former default holding files at the current
   * provider; it is demoted (from the provider it was made under) so it can come back in turn.
   * All of it in one transaction: switching back and forth never adds environments.
   *
   * Replacing one first takes the person's membership row (`FOR SHARE`, after the org row), so an
   * offboarding that removes them cannot leave a live default behind; not a member (any more) →
   * `org.not_found`. Idempotent under concurrency: the live default row and the person's former
   * defaults of the current provider are locked (`FOR NO KEY UPDATE`) and the live default re-read
   * after them, the partial unique index on the live default makes a racing insert do nothing, and
   * the select that follows reads the winner. Needs a current sandbox provider
   * (`environment.unavailable`). It is the person's baseline, so it is created even at
   * `environments.maxPersonal`.
   */
  async ensureDefault(orgId: string, accountId: string): Promise<string> {
    const live = await this.defaultOf(orgId, accountId);
    if (live && !this.stranded(live)) {
      const current = this.providers.current()?.plugin;
      if (holdsResources(live) || current === undefined) return live.id;
      const former = await this.formerDefaults(orgId, accountId, current);
      if (!former.some((f) => f.holdsFiles)) return live.id;
    }
    return this.insertDefault(orgId, accountId);
  }

  @Transactional()
  private async insertDefault(orgId: string, accountId: string): Promise<string> {
    const current = this.providers.current();
    if (!current) throw environmentUnavailable(null);
    await this.lockMember(orgId, accountId, "share");
    const locked = await this.defaultOf(orgId, accountId, true);
    const former = await this.formerDefaults(orgId, accountId, current.plugin, true);
    // a racing replacement committed while this waited: its default is the answer
    const live = locked ?? (await this.defaultOf(orgId, accountId));
    if (live && live !== locked) return live.id;
    const stranded = live !== undefined && this.stranded(live);
    const withFiles = former.find((f) => f.holdsFiles);
    if (live && !stranded && (holdsResources(live) || withFiles === undefined)) return live.id;
    // a default is needed (none, or a stranded one): any former default will do, files first
    const restore = withFiles ?? (live === undefined || stranded ? former[0] : undefined);
    if (live) {
      const from = stranded
        ? (environmentProvider(live, current.plugin) ?? "unknown")
        : (live.provider ?? current.plugin);
      await this.demote(live.id, from);
    }
    if (restore) {
      await this.db
        .updateTable("environments")
        .set({ is_default: true, demoted_from_provider: null, updated_at: sql<Date>`now()` })
        .where("id", "=", restore.id)
        .execute();
      return restore.id;
    }
    await this.db
      .insertInto("environments")
      .values({
        id: randomUUID(),
        org_id: orgId,
        owner_kind: "personal",
        owner_account_id: accountId,
        name: null,
        is_default: true,
        source: "cloud",
        provider: current.plugin,
      })
      .onConflict((oc) =>
        oc
          .columns(["org_id", "owner_account_id"])
          .where(sql<boolean>`is_default AND deleted_at IS NULL`)
          .doNothing(),
      )
      .execute();
    const row = await this.defaultOf(orgId, accountId);
    if (row === undefined) throw new Error("the default environment was not created");
    return row.id;
  }

  /**
   * Turns the live default into an ordinary environment marked as demoted from `provider`; a name
   * the person gave it stays. Runs under the person's membership lock and the default row's lock,
   * before any other row becomes the default (the partial unique index).
   */
  private async demote(id: string, provider: string): Promise<void> {
    await this.db
      .updateTable("environments")
      .set({ is_default: false, demoted_from_provider: provider, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * The person's live former defaults demoted from `provider` that the current provider can use
   * (no files, or files kept by `provider`), the ones holding files first, then the most recently
   * used, then the most recently demoted. `lock` takes their rows (`FOR NO KEY UPDATE`, in id
   * order, so racing replacements queue on the same rows).
   */
  private async formerDefaults(
    orgId: string,
    accountId: string,
    provider: string,
    lock = false,
  ): Promise<{ id: string; holdsFiles: boolean }[]> {
    const rows = await this.db
      .selectFrom("environments as e")
      .leftJoin("environment_instances as i", "i.environment_id", "e.id")
      .select([
        "e.id",
        "e.provider",
        "e.updated_at",
        "i.provider as instance_provider",
        "i.fs_status",
        "i.handle",
        "i.last_used_at",
      ])
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.is_default", "=", false)
      .where("e.demoted_from_provider", "=", provider)
      .where("e.deleted_at", "is", null)
      .orderBy("e.id")
      .$if(lock, (q) => q.forNoKeyUpdate("e"))
      .execute();
    const time = (d: Date | null) => d?.getTime() ?? 0;
    return rows
      .map((r) => {
        const facts: ProviderFacts = {
          provider: r.provider,
          instanceProvider: r.instance_provider,
          fsStatus: r.fs_status,
          hasInstance: r.handle !== null,
        };
        return { r, holdsFiles: holdsResources(facts), facts };
      })
      .filter(({ facts }) => environmentProvider(facts, provider) === provider)
      .sort(
        (a, b) =>
          Number(b.holdsFiles) - Number(a.holdsFiles) ||
          time(b.r.last_used_at) - time(a.r.last_used_at) ||
          time(b.r.updated_at) - time(a.r.updated_at),
      )
      .map(({ r, holdsFiles }) => ({ id: r.id, holdsFiles }));
  }

  /**
   * The person's IM default (what `/env` set): the environment their next new IM conversation
   * uses. Null when none was set, or the chosen one is deleted (the row is cleared with it).
   */
  async imDefault(orgId: string, accountId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("environment_defaults as d")
      .innerJoin("environments as e", "e.id", "d.environment_id")
      .select("e.id")
      .where("d.org_id", "=", orgId)
      .where("d.account_id", "=", accountId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * Sets the person's IM default. Only one of their own live environments in the org, usable now
   * (`environment.not_found` / `environment.unavailable` otherwise); the row is written by one
   * statement that re-checks the environment is live. There is no row lock, so a delete racing
   * past that check can leave a stale row; reads ignore it ({@link imDefault} joins on
   * `deleted_at IS NULL`).
   */
  async setImDefault(orgId: string, accountId: string, environmentId: string): Promise<void> {
    await this.access.usable(orgId, accountId, environmentId);
    const written = await this.db
      .insertInto("environment_defaults")
      .columns(["org_id", "account_id", "environment_id"])
      .expression(
        this.db
          .selectFrom("environments")
          .select([
            sql<string>`${orgId}::text`.as("org_id"),
            sql<string>`${accountId}::text`.as("account_id"),
            "id",
          ])
          .where("id", "=", environmentId)
          .where("org_id", "=", orgId)
          .where("owner_kind", "=", "personal")
          .where("owner_account_id", "=", accountId)
          .where("deleted_at", "is", null),
      )
      .onConflict((oc) =>
        oc
          .columns(["org_id", "account_id"])
          .doUpdateSet({ environment_id: environmentId, updated_at: new Date() }),
      )
      .executeTakeFirst();
    if (Number(written.numInsertedOrUpdatedRows ?? 0) === 0) throw environmentNotFound();
  }

  /**
   * The person's live default environment in the org, if any, with what decides its provider;
   * `lock` takes its row (`FOR NO KEY UPDATE`; a racing demotion makes it read none).
   */
  private async defaultOf(
    orgId: string,
    accountId: string,
    lock = false,
  ): Promise<(ProviderFacts & { id: string }) | undefined> {
    const row = await this.db
      .selectFrom("environments as e")
      .leftJoin("environment_instances as i", "i.environment_id", "e.id")
      .select(["e.id", "e.provider", "i.provider as instance_provider", "i.fs_status", "i.handle"])
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.is_default", "=", true)
      .where("e.deleted_at", "is", null)
      .$if(lock, (q) => q.forNoKeyUpdate("e"))
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        provider: row.provider,
        instanceProvider: row.instance_provider,
        fsStatus: row.fs_status,
        hasInstance: row.handle !== null,
      }
    );
  }

  /** Its files or instance are kept by a provider that is not the current one. */
  private stranded(f: ProviderFacts): boolean {
    const current = this.providers.current()?.plugin;
    return current !== undefined && environmentProvider(f, current) !== current;
  }

  /** The person's live environments (or the one `id`) as views. */
  private async views(orgId: string, accountId: string, id?: string): Promise<EnvironmentView[]> {
    // all of them even for one `id`: a former default's ordinal counts its siblings
    const all = await this.db
      .selectFrom("environments as e")
      .leftJoin("environment_instances as i", "i.environment_id", "e.id")
      .select([
        "e.id",
        "e.name",
        "e.is_default",
        "e.provider",
        "e.demoted_from_provider",
        "e.created_at",
        "i.provider as instance_provider",
        "i.fs_status",
        "i.handle",
        "i.status",
        "i.last_used_at",
      ])
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .orderBy("e.is_default", "desc")
      .orderBy("e.created_at")
      .orderBy("e.id")
      .execute();
    const rows = id === undefined ? all : all.filter((r) => r.id === id);
    if (rows.length === 0) return [];
    const ordinals = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const r of [...all].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
    )) {
      if (r.demoted_from_provider === null || r.name !== null) continue;
      const n = (seen.get(r.demoted_from_provider) ?? 0) + 1;
      seen.set(r.demoted_from_provider, n);
      ordinals.set(r.id, n);
    }
    const demotedProviders = [
      ...new Set(
        rows.flatMap((r) => (r.demoted_from_provider === null ? [] : [r.demoted_from_provider])),
      ),
    ];
    const [limits, names] = await Promise.all([
      this.sandbox.orgLimits(orgId),
      this.displayNames.many(demotedProviders),
    ]);
    const current = this.providers.current()?.plugin;
    return rows.map((r) => {
      const provider = environmentProvider(
        {
          provider: r.provider,
          instanceProvider: r.instance_provider,
          fsStatus: r.fs_status,
          hasInstance: r.handle !== null,
        },
        current,
      );
      const live = (r.status === "running" || r.status === "suspended") && r.last_used_at;
      const from = r.demoted_from_provider;
      return {
        id: r.id,
        name: r.name,
        isDefault: r.is_default,
        demotedFrom:
          from === null
            ? null
            : {
                provider: from,
                displayName: names.get(from) ?? null,
                ordinal: ordinals.get(r.id) ?? 1,
              },
        ownerKind: "personal",
        source: "cloud",
        provider,
        available: current !== undefined && provider === current,
        sessionIsolation: false,
        filesLost: r.fs_status === "lost",
        instance: live
          ? {
              status: r.status as "running" | "suspended",
              lastUsedAt: (r.last_used_at as Date).toISOString(),
            }
          : null,
        limits: { ...limits, allowHosts: [...limits.allowHosts] },
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /**
   * Serializes the person's environment writes in the org: the org row (`FOR SHARE`), then their
   * membership row (`FOR NO KEY UPDATE`, or `FOR SHARE` with `mode` share: enough to keep the
   * membership from being removed meanwhile), the order member removal locks them in. Not a
   * member (any more) → `org.not_found`, as the org guard answers.
   */
  private async lockMember(
    orgId: string,
    accountId: string,
    mode: "update" | "share" = "update",
  ): Promise<void> {
    const org = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    const m =
      org &&
      (await this.db
        .selectFrom("memberships")
        .select("account_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .$if(mode === "update", (q) => q.forNoKeyUpdate())
        .$if(mode === "share", (q) => q.forShare())
        .executeTakeFirst());
    if (!m) throw new ApiError("org.not_found", "Organization not found");
  }

  /** Locks one of the person's live environments (after their membership); else `not_found`. */
  private async lockOwn(
    orgId: string,
    accountId: string,
    id: string,
  ): Promise<{ name: string | null; is_default: boolean }> {
    await this.lockMember(orgId, accountId);
    const row = await this.db
      .selectFrom("environments")
      .select(["name", "is_default"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row) throw environmentNotFound();
    return row;
  }

  private async assertNameFree(orgId: string, accountId: string, name: string): Promise<void> {
    const clash = await this.db
      .selectFrom("environments")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst();
    if (clash) throw nameTaken();
  }
}
