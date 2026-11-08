import { randomUUID } from "node:crypto";
import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { deviceLeaseKey } from "../local-devices/keys.js";
import { MachinesService } from "../local-devices/machines.js";
import type { KernelLogger } from "../log.js";
import { SandboxJobs } from "../sandbox/jobs.js";
import { isInternalProvider, LOCAL_PROVIDER, SandboxProviders } from "../sandbox/providers.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import { DeviceAccess, deviceProvider, deviceUnavailable, type ProviderFacts } from "./access.js";

/** A device as its owner sees it (`GET /orgs/:orgId/devices`). */
export interface DeviceView {
  id: string;
  /** null for the default device (shown as 「个人设备」 / "Personal"). */
  name: string | null;
  isDefault: boolean;
  ownerKind: "personal";
  /** `local`: a machine connected with capybara-device (provider `@local`). */
  source: "cloud" | "local";
  /** The provider keeping its files, or the one its first use will create them with. */
  provider: string | null;
  /** Its provider is there: the deployment's current cloud provider, or `@local` registered. */
  available: boolean;
  /** A local device: some replica holds its machine's connection now; null for cloud. */
  online: boolean | null;
  /** A local device's connected machine (its unrevoked one); null for cloud or none. */
  machine: DeviceMachineView | null;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /** The org's effective sandbox limits (phase 1 devices use them unchanged, spec §8.4). */
  limits: SandboxLimits;
  createdAt: string;
}

/** The machine connected to a local device, as its owner sees it. */
export interface DeviceMachineView {
  id: string;
  name: string;
  os: string;
  mode: "os" | "docker" | null;
  programVersion: string | null;
  lastSeenAt: string | null;
}

/** The list response: the person's live devices in the org. */
export interface DeviceList {
  items: DeviceView[];
  /** The person's default device; null when there is none (no sandbox provider to make it). */
  defaultId: string | null;
  /** The device of the person's most recently updated conversation that has a live one. */
  lastUsedId: string | null;
  /** There is a current sandbox provider (new cloud devices can be made; ruling R4). */
  cloudAvailable: boolean;
}

const isUniqueViolation = (e: unknown, constraint: string): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === constraint;

const nameTaken = (): ApiError =>
  new ApiError("device.name_taken", "You already have a device with this name");

/**
 * Personal devices (spec 2026-11-07-environments-design §4.2 items 7, 12, 13; §6; §9):
 * cloud ones on the deployment's sandbox provider and `device` ones on a connected machine; a
 * person's devices in an org, visible and usable only by their owner (anyone else gets
 * `device.not_found`). Deleting one soft-deletes it and destroys its instance and files in a
 * `sandbox-destroy-for` job after the commit.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "orgLimits">,
    @Inject(SandboxJobs) private readonly sandboxJobs: Pick<SandboxJobs, "destroy" | "resetFiles">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    /** Reads the device relay's lease (`online`). */
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(MachinesService)
    private readonly machines: Pick<MachinesService, "revoke" | "revokeActive">,
  ) {}

  /**
   * The person's live devices in the org, the default first, then by creation. With a
   * current sandbox provider the default device is created first if missing (its first need,
   * spec §4.2 item 7; an existing one is only read).
   */
  async list(orgId: string, accountId: string): Promise<DeviceList> {
    const cloudAvailable = this.providers.cloud() !== undefined;
    const defaultId = cloudAvailable ? await this.ensureDefault(orgId, accountId) : null;
    const items = await this.views(orgId, accountId);
    const last = await this.db
      .selectFrom("conversations as c")
      .innerJoin("devices as e", "e.id", "c.device_id")
      .select("c.device_id")
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
      lastUsedId: last?.device_id ?? null,
      cloudAvailable,
    };
  }

  /** One of the person's live devices; anyone else's (or a missing one) → `not_found`. */
  async get(orgId: string, accountId: string, id: string): Promise<DeviceView> {
    const [view] = await this.views(orgId, accountId, id);
    if (!view) throw deviceNotFound();
    return view;
  }

  /**
   * A new personal cloud device, ready at once (its instance and files are made on first
   * use). Needs a current sandbox provider (`device.unavailable`); a live name of the person's
   * (case-insensitive) → `device.name_taken`; `devices.maxPersonal` live ones (the
   * default counts) → `device.limit_reached`. Serialized per person by their membership row.
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<DeviceView> {
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
    const current = this.providers.cloud();
    if (!current) throw deviceUnavailable(null);
    return this.insertNamed(
      orgId,
      accountId,
      name,
      "cloud",
      current.plugin,
      actorTokenId,
      auditDetail ?? {},
    );
  }

  /**
   * A new personal local device for a machine being connected (provider `@local`; the
   * machine row is the caller's). Joins the caller's transaction (the device authorization's).
   * Counted against `devices.maxPersonal` (`device.limit_reached`); a live name of the
   * person's → `device.name_taken`. Needs no cloud provider.
   */
  @Transactional()
  async createLocal(orgId: string, accountId: string, name: string): Promise<{ id: string }> {
    const id = await this.insertNamed(orgId, accountId, name, "local", LOCAL_PROVIDER, undefined, {
      source: "local",
    });
    return { id };
  }

  /**
   * Inserts a named personal device under the person's membership lock, after the limit
   * and name checks, and audits `device.created`. Runs in the caller's transaction.
   */
  private async insertNamed(
    orgId: string,
    accountId: string,
    name: string,
    source: "cloud" | "local",
    provider: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown>,
  ): Promise<string> {
    await this.lockMember(orgId, accountId);
    const { n } = await this.db
      .selectFrom("devices")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const max = this.config.get().devices.maxPersonal;
    if (Number(n) >= max) {
      throw new ApiError(
        "device.limit_reached",
        `You already have ${max} devices in this organization; delete one to create another`,
      );
    }
    await this.assertNameFree(orgId, accountId, name);
    const id = randomUUID();
    try {
      await this.db
        .insertInto("devices")
        .values({
          id,
          org_id: orgId,
          owner_kind: "personal",
          owner_account_id: accountId,
          name,
          source,
          provider,
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "devices_name_uq")) throw nameTaken();
      throw e;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.created",
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
    if (!this.providers.cloud()) throw deviceUnavailable(null);
    const { n } = await this.db
      .selectFrom("devices")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const max = this.config.get().devices.maxPersonal;
    if (Number(n) >= max) {
      throw new ApiError(
        "device.limit_reached",
        `You already have ${max} devices in this organization; delete one to create another`,
      );
    }
    await this.assertNameFree(orgId, accountId, name);
  }

  /** How many of the person's conversations work in the device (read only). */
  async boundConversations(orgId: string, accountId: string, id: string): Promise<number> {
    const { n } = await this.db
      .selectFrom("conversations")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("device_id", "=", id)
      .executeTakeFirstOrThrow();
    return Number(n);
  }

  /**
   * The refusals {@link resetFiles} would raise (not found, its provider not current, a connected
   * device), read only.
   */
  async checkReset(orgId: string, accountId: string, id: string): Promise<void> {
    refuseDeviceReset(await this.access.usable(orgId, accountId, id));
  }

  /** The refusals {@link rename} would raise, read without locks (see {@link checkCreate}). */
  async checkRename(orgId: string, accountId: string, id: string, name: string): Promise<void> {
    const before = await this.get(orgId, accountId, id);
    if (before.name?.toLowerCase() !== name.toLowerCase()) {
      await this.assertNameFree(orgId, accountId, name);
    }
  }

  /** Renames one of the person's live devices (the default too); see {@link create}. */
  async rename(
    orgId: string,
    accountId: string,
    id: string,
    name: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<DeviceView> {
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
    // the same name in another case is this device's own: the index allows it
    if (before.name?.toLowerCase() !== name.toLowerCase()) {
      await this.assertNameFree(orgId, accountId, name);
    }
    try {
      await this.db
        .updateTable("devices")
        .set({ name, updated_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "devices_name_uq")) throw nameTaken();
      throw e;
    }
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.renamed",
      target: id,
      detail: { from: before.name, to: name, ...auditDetail },
    });
  }

  /**
   * Deletes one of the person's live devices: soft delete, its IM default row cleared, and
   * after the commit a `sandbox-destroy-for` job (the worker waits for running commands, then
   * destroys the instance and the files). Conversations bound to it keep pointing at it; their
   * sandbox tools then fail with `device.not_found`. A local device's machine is
   * revoked in the same transaction; after the commit it is told `stop { reason: "deleted" }`
   * (while connected) and its connection is closed.
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
      .updateTable("devices")
      .set({ deleted_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    await this.db
      .deleteFrom("device_defaults")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("device_id", "=", id)
      .execute();
    await this.machines.revokeActive(id, "deleted");
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.deleted",
      target: id,
      detail: { name: before.name, isDefault: before.is_default, ...auditDetail },
    });
    afterCommit(async () => {
      try {
        await this.sandboxJobs.destroy([id]);
      } catch (err) {
        // the hourly destruction sweep destroys deleted devices too
        this.log.warn("cannot schedule device destruction", { deviceId: id, err });
      }
    });
  }

  /**
   * Disconnects the machine of one of the person's own local devices (it must sign in
   * again); see {@link MachinesService.revoke}.
   */
  async revokeMachine(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.machines.revoke(orgId, accountId, id, actorTokenId);
  }

  /**
   * Starts one of the person's devices over with empty files (after
   * `device.files_lost`): records the request (audit), then, after the commit, enqueues the
   * `sandbox-reset-files` job (deterministic id per device), whose worker waits for running
   * commands and destroys any instance and the file system; the next use creates new ones. Its
   * provider must be the current one (`device.unavailable`); a local device's files
   * are its machine owner's (`device.files_on_device`). An enqueue failure is thrown
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
    refuseDeviceReset(await this.access.usable(orgId, accountId, id));
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.files_reset",
      target: id,
      ...(auditDetail !== undefined && { detail: auditDetail }),
    });
  }

  /**
   * The person's default device in the org, created when missing (named by the UI, `name`
   * NULL). An existing usable one is read without locking. A live default whose files or
   * instance are kept by a provider that is not the current one (a provider switch, spec §4.2
   * item 13) is stranded: it is demoted, named `Personal (<provider>)` (` 2`, ` 3`, … when that
   * name is taken) and stays listed as unavailable and deletable, and a fresh default is created,
   * in one transaction. Creating one first takes the person's membership row (`FOR SHARE`, after
   * the org row), so an offboarding that removes them cannot leave a live default behind, and
   * their creates and renames (`FOR NO KEY UPDATE`) cannot race the demoted name; not a member
   * (any more) → `org.not_found`. Idempotent under concurrency: the demotion locks the default
   * row and re-checks it, the partial unique index on the live default makes a racing insert do
   * nothing, and the select that follows reads the winner. Needs a current sandbox provider
   * (`device.unavailable`). It is the person's baseline, so it is created even at
   * `devices.maxPersonal`.
   */
  async ensureDefault(orgId: string, accountId: string): Promise<string> {
    const live = await this.defaultOf(orgId, accountId);
    if (live && !this.stranded(live)) return live.id;
    return this.insertDefault(orgId, accountId);
  }

  @Transactional()
  private async insertDefault(orgId: string, accountId: string): Promise<string> {
    const current = this.providers.cloud();
    if (!current) throw deviceUnavailable(null);
    await this.lockMember(orgId, accountId, "share");
    const live = await this.defaultOf(orgId, accountId, true);
    if (live && !this.stranded(live)) return live.id;
    if (live) {
      const held = deviceProvider(live, current.plugin) ?? "unknown";
      await this.demote(orgId, accountId, live.id, held);
    }
    await this.db
      .insertInto("devices")
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
    if (row === undefined) throw new Error("the default device was not created");
    return row.id;
  }

  /**
   * Turns a stranded default into an ordinary device named `Personal (<provider>)`, with
   * ` 2`, ` 3`, … appended while that name is one of the person's live names (case-insensitive).
   * Runs under the person's membership lock and the default row's lock.
   */
  private async demote(
    orgId: string,
    accountId: string,
    id: string,
    provider: string,
  ): Promise<void> {
    const base = `Personal (${provider})`;
    const taken = new Set(
      (
        await this.db
          .selectFrom("devices")
          .select("name")
          .where("org_id", "=", orgId)
          .where("owner_account_id", "=", accountId)
          .where("deleted_at", "is", null)
          .where("name", "is not", null)
          .execute()
      ).map((r) => (r.name as string).toLowerCase()),
    );
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    await this.db
      .updateTable("devices")
      .set({ is_default: false, name, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * The person's IM default (what `/device` set): the device their next new IM conversation
   * uses. Null when none was set, or the chosen one is deleted (the row is cleared with it).
   */
  async imDefault(orgId: string, accountId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("device_defaults as d")
      .innerJoin("devices as e", "e.id", "d.device_id")
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
   * Sets the person's IM default. Only one of their own live devices in the org, usable now
   * (`device.not_found` / `device.unavailable` otherwise); the row is written by one
   * statement that re-checks the device is live. There is no row lock, so a delete racing
   * past that check can leave a stale row; reads ignore it ({@link imDefault} joins on
   * `deleted_at IS NULL`).
   */
  async setImDefault(orgId: string, accountId: string, deviceId: string): Promise<void> {
    await this.access.usable(orgId, accountId, deviceId);
    const written = await this.db
      .insertInto("device_defaults")
      .columns(["org_id", "account_id", "device_id"])
      .expression(
        this.db
          .selectFrom("devices")
          .select([
            sql<string>`${orgId}::text`.as("org_id"),
            sql<string>`${accountId}::text`.as("account_id"),
            "id",
          ])
          .where("id", "=", deviceId)
          .where("org_id", "=", orgId)
          .where("owner_kind", "=", "personal")
          .where("owner_account_id", "=", accountId)
          .where("deleted_at", "is", null),
      )
      .onConflict((oc) =>
        oc
          .columns(["org_id", "account_id"])
          .doUpdateSet({ device_id: deviceId, updated_at: new Date() }),
      )
      .executeTakeFirst();
    if (Number(written.numInsertedOrUpdatedRows ?? 0) === 0) throw deviceNotFound();
  }

  /**
   * The person's live default device in the org, if any, with what decides its provider;
   * `lock` takes its row (`FOR NO KEY UPDATE`; a racing demotion makes it read none).
   */
  private async defaultOf(
    orgId: string,
    accountId: string,
    lock = false,
  ): Promise<(ProviderFacts & { id: string }) | undefined> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
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
    const current = this.providers.cloud()?.plugin;
    return current !== undefined && deviceProvider(f, current) !== current;
  }

  /** The person's live devices (or the one `id`) as views. */
  private async views(orgId: string, accountId: string, id?: string): Promise<DeviceView[]> {
    const rows = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select([
        "e.id",
        "e.name",
        "e.is_default",
        "e.source",
        "e.provider",
        "e.created_at",
        "m.id as machine_id",
        "m.name as machine_name",
        "m.os as machine_os",
        "m.mode as machine_mode",
        "m.program_version as machine_program_version",
        "m.last_seen_at as machine_last_seen_at",
        "m.session_isolation as machine_session_isolation",
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
      .$if(id !== undefined, (q) => q.where("e.id", "=", id as string))
      .orderBy("e.is_default", "desc")
      .orderBy("e.created_at")
      .orderBy("e.id")
      .execute();
    if (rows.length === 0) return [];
    const limits = await this.sandbox.orgLimits(orgId);
    const current = this.providers.cloud()?.plugin;
    // a local device is online while a replica holds its machine's connection lease
    const online = new Map(
      await Promise.all(
        rows
          .filter((r) => r.source === "local")
          .map(
            async (r) =>
              [r.id, (await this.locks.holderOf(deviceLeaseKey(r.id))) !== null] as const,
          ),
      ),
    );
    return rows.map((r) => {
      const provider = deviceProvider(
        {
          provider: r.provider,
          instanceProvider: r.instance_provider,
          fsStatus: r.fs_status,
          hasInstance: r.handle !== null,
        },
        current,
      );
      const live = (r.status === "running" || r.status === "suspended") && r.last_used_at;
      return {
        id: r.id,
        name: r.name,
        isDefault: r.is_default,
        ownerKind: "personal",
        source: r.source,
        provider,
        available:
          provider !== null && isInternalProvider(provider)
            ? this.providers.forName(provider) !== undefined
            : current !== undefined && provider === current,
        online: r.source === "local" ? (online.get(r.id) ?? false) : null,
        machine:
          r.machine_id !== null && r.machine_name !== null && r.machine_os !== null
            ? {
                id: r.machine_id,
                name: r.machine_name,
                os: r.machine_os,
                mode: r.machine_mode,
                programVersion: r.machine_program_version,
                lastSeenAt: r.machine_last_seen_at?.toISOString() ?? null,
              }
            : null,
        // a local device's machine decides it; cloud devices have none in phase 2
        sessionIsolation: r.machine_session_isolation ?? false,
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
   * Serializes the person's device writes in the org: the org row (`FOR SHARE`), then their
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

  /** Locks one of the person's live devices (after their membership); else `not_found`. */
  private async lockOwn(
    orgId: string,
    accountId: string,
    id: string,
  ): Promise<{ name: string | null; is_default: boolean }> {
    await this.lockMember(orgId, accountId);
    const row = await this.db
      .selectFrom("devices")
      .select(["name", "is_default"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    return row;
  }

  private async assertNameFree(orgId: string, accountId: string, name: string): Promise<void> {
    const clash = await this.db
      .selectFrom("devices")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst();
    if (clash) throw nameTaken();
  }
}

/**
 * Ruling R24: a local device's files are in a directory on its machine, which the
 * platform never wipes; a lost directory comes back with `capybara-device logout` and a new `login` on the machine.
 */
function refuseDeviceReset(env: { provider: string | null }): void {
  if (env.provider === LOCAL_PROVIDER) {
    throw new ApiError(
      "device.files_on_device",
      "This device's files are in a directory on its connected machine and cannot be reset from here. To start over, run capybara-device logout, then capybara-device login into this device, on that machine.",
    );
  }
}
