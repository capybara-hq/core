import { randomUUID } from "node:crypto";
import {
  type DeviceFeature,
  type DeviceLocalPolicySummary,
  type LocalizedName,
  minTier,
  type SandboxLimits,
  type SandboxTier,
  tierAtMost,
} from "@capybara-hq/plugin-sdk";
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
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { DevicePolicyService } from "../local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../local-devices/keys.js";
import { MachinesService } from "../local-devices/machines.js";
import { deviceFeaturesOf, localPolicyOf } from "../local-devices/policy-summary.js";
import type { KernelLogger } from "../log.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import type { DeviceSandboxLevel } from "../runtime/context/device-paths.js";
import { SandboxJobs } from "../sandbox/jobs.js";
import { isInternalProvider, LOCAL_PROVIDER, SandboxProviders } from "../sandbox/providers.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import { type EffectiveSandboxPolicy, effectiveSandboxPolicy } from "../sandbox/tiers.js";
import { unattendedTierOf } from "../schedules/unattended.js";
import {
  DeviceAccess,
  demotedProvider,
  deviceProvider,
  deviceUnavailable,
  type InstanceStatus,
  inUseForDefault,
  type ProviderFacts,
} from "./access.js";

/** A device as its owner sees it (`GET /orgs/:orgId/devices`). */
export interface DeviceView {
  id: string;
  /**
   * null for the default device (shown as 「个人设备」 / "Personal") and for a demoted default
   * (shown as 「个人设备（Docker 沙箱）」 / "Personal (Docker sandbox)", from {@link demotedFrom}).
   */
  name: string | null;
  isDefault: boolean;
  /**
   * A former default demoted by a sandbox provider switch (spec §4.2 item 13): the provider it was
   * demoted from, that extension's display name (null when it has none, e.g. uninstalled: show the
   * id), and its place among the person's unnamed former defaults of that provider (1, 2, … by
   * creation; a label shows " 2", " 3", … after the first). Switching back to that provider makes
   * it the default again. null for every other device.
   */
  demotedFrom: { provider: string; displayName: LocalizedName | null; ordinal: number } | null;
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
  /**
   * A local device's network facts as its connected machine last reported them (network
   * ask-to-allow spec §5.4): the program's features and its local policy summary (null when
   * unknown). null for a cloud device or a local one without a connected machine.
   */
  network: {
    features: string[];
    policy: DeviceLocalPolicySummary | null;
  } | null;
  /** Its sandbox level (sandbox dev tiers spec §4, §11.1). */
  sandbox: DeviceSandboxView;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /**
   * The sandbox limits of its effective tier (sandbox dev tiers spec §4.2): what a cloud
   * instance is created with; for a local device the network of the org's default tier.
   */
  limits: SandboxLimits;
  createdAt: string;
}

/**
 * A device's sandbox level as its owner sees it (sandbox dev tiers spec §4, §11.1).
 */
export interface DeviceSandboxView {
  /**
   * The tier the owner chose: a cloud device's stored one, a local device's as its machine last
   * reported it; null follows the org's default.
   */
  tier: SandboxTier | null;
  /**
   * The tier its commands run at: min(chosen ?? the org's default, ceiling); `strict` for a local
   * device whose program lacks the `tiers` feature (it runs as before tiers).
   */
  effectiveTier: SandboxTier;
  /** The highest tier the device may reach: min(the org's max, the platform's max). */
  ceiling: SandboxTier;
  /** Which ceiling lowered the chosen tier; null when none did. */
  cappedBy: "org" | "platform" | null;
  /** The org's default tier for devices that choose none (at most {@link ceiling}). */
  defaultTier: SandboxTier;
  /** The org and the platform let a local device run without a sandbox (its ceiling is `open`). */
  allowUnsandboxed: boolean;
  /** `none`: a local device runs its commands without a sandbox (its owner set it locally). */
  isolation: "sandbox" | "none";
  /**
   * A cloud device's instance runs another tier or network than {@link effectiveTier}: its next
   * use updates or recreates it, files kept (「下次使用时生效，文件保留」).
   */
  pendingNextUse: boolean;
  /**
   * A cloud device's new tier waits for a file reset: its provider applies limits only when the
   * file system is made (`limitsApplyAt: "fileSystem"`) and cannot update them.
   */
  pendingFilesReset: boolean;
  /** Its last {@link RECENT_POLICY_CHANGES} sandbox changes, newest first (§10.4). */
  recent: DeviceSandboxChangeView[];
}

/** How many recent sandbox changes a device view lists. */
export const RECENT_POLICY_CHANGES = 10;

/**
 * One sandbox change of a device, as its owner sees it on the device page (§10.4):
 * - `policy` (`device.policy_changed`): a local policy change sent to the machine;
 * - `tier` (`device.tier_changed`): a cloud device's tier set by its owner;
 * - `isolation` (`device.isolation_reported`): the machine reported running without a sandbox,
 *   or with one again.
 */
export interface DeviceSandboxChangeView {
  at: string;
  kind: "policy" | "tier" | "isolation";
  /** Hosts added to / removed from the local allowlist (`policy` only; else empty). */
  add: string[];
  remove: string[];
  /** The tier set (`to: null`: follow the org's default); null when the tier did not change. */
  tier: { to: SandboxTier | null } | null;
  /** The isolation set or reported; null when it did not change. */
  isolation: "sandbox" | "none" | null;
  /** The deciding account's display name (null when the account is gone). */
  by: string | null;
  /** `device`: reported by the machine itself (`isolation`). */
  via: "web" | "im" | "device";
  /** The machine answered with the policy as written (false: the answer never came). */
  confirmed: boolean;
}

/** A change of a local device's policy by its owner (`POST /devices/:id/policy`). */
export interface DevicePolicyChange {
  add?: string[] | undefined;
  remove?: string[] | undefined;
  /** null: follow the org's default. */
  tier?: SandboxTier | null | undefined;
  isolation?: "sandbox" | undefined;
}

/** What `PATCH /devices/:id` changes. */
export interface DevicePatch {
  name?: string;
  /** A cloud device's tier; null follows the org's default. */
  tier?: SandboxTier | null;
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
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "deviceLimits" | "limitsState">,
    @Inject(SandboxJobs) private readonly sandboxJobs: Pick<SandboxJobs, "destroy" | "resetFiles">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    /** Reads the device relay's lease (`online`). */
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(MachinesService)
    private readonly machines: Pick<MachinesService, "revoke" | "revokeActive">,
    @Inject(DevicePolicyService)
    private readonly policies: Pick<DevicePolicyService, "apply" | "summary">,
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

  /**
   * Renames one of the person's live devices (the default too); see {@link create}. A
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
    await this.renameLocked(orgId, accountId, id, before, name, actorTokenId, auditDetail);
  }

  /**
   * `PATCH /devices/:id` (sandbox dev tiers spec §7.2): renames one of the person's live devices
   * ({@link rename}) and sets a cloud device's sandbox tier, in one transaction. The tier: null
   * follows the org's default; above the device's ceiling (the org's or the platform's max) →
   * `device.tier_not_allowed`; a local device → `device.tier_on_device` (its tier is its
   * machine's, changed with {@link changePolicy}). A changed tier is audited `device.tier_changed`
   * (`from` / `to`); the device's next use applies it (the instance is updated, or recreated on
   * the kept files). Callers make sure only a person in a session sets the tier.
   */
  async update(
    orgId: string,
    accountId: string,
    id: string,
    patch: DevicePatch,
    actorTokenId?: string,
  ): Promise<DeviceView> {
    await this.updateIn(orgId, accountId, id, patch, actorTokenId);
    return this.get(orgId, accountId, id);
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    accountId: string,
    id: string,
    patch: DevicePatch,
    actorTokenId: string | undefined,
  ): Promise<void> {
    const before = await this.lockOwn(orgId, accountId, id);
    if (patch.tier !== undefined) {
      if (before.source !== "cloud") {
        throw new ApiError(
          "device.tier_on_device",
          "This device's sandbox level is kept on its connected machine: change it from the device page (sent to the machine) or run capybara-device policy set tier <strict|dev|open|default> there.",
        );
      }
      const policy = await this.policyFor(orgId, patch.tier);
      if (patch.tier !== null && !tierAtMost(patch.tier, policy.ceiling)) {
        throw tierNotAllowed(patch.tier, policy);
      }
      if (patch.tier !== before.tier) {
        await this.db
          .updateTable("devices")
          .set({ tier: patch.tier, updated_at: sql<Date>`now()` })
          .where("id", "=", id)
          .execute();
        await audit(this.db.db, {
          actorAccountId: accountId,
          ...(actorTokenId !== undefined && { actorTokenId }),
          orgId,
          action: "device.tier_changed",
          target: id,
          detail: { from: before.tier, to: patch.tier },
        });
      }
    }
    if (patch.name !== undefined) {
      await this.renameLocked(orgId, accountId, id, before, patch.name, actorTokenId, undefined);
    }
  }

  /** The org's sandbox policy for a device choosing `tier` (null: the org's default). */
  private async policyFor(
    orgId: string,
    tier: SandboxTier | null,
  ): Promise<EffectiveSandboxPolicy> {
    return effectiveSandboxPolicy(
      this.config.get().sandbox,
      await readOrgSettings(this.db.db, orgId),
      tier,
    );
  }

  /**
   * The sandbox level a sandbox call in the device runs at now, for the model (`device_paths`,
   * spec §11.5): see {@link sandboxStateOf}, plus
   * - `network: "none"` when the org's or the platform's sandbox network is off;
   * - a cloud device whose new limits wait for a file reset: the tier and network its instance
   *   still runs with (`limitsState(...).applied`);
   * - a local device: its machine's localhost and unix socket facts; in a scheduled run without
   *   a person (`runId`, {@link unattendedTierOf}) and without the task's `tier:open` grant its
   *   tier is capped at `dev`, as the exec args cap it;
   * - `unattended` in such a run: nobody can approve a domain.
   * Null when the device is not a live device of the org.
   */
  async sandboxLevel(
    orgId: string,
    deviceId: string,
    runId?: string,
  ): Promise<DeviceSandboxLevel | null> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.source", "e.tier", "m.features", "m.local_policy"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const [settings, unattended] = await Promise.all([
      readOrgSettings(this.db.db, orgId),
      runId === undefined ? null : unattendedTierOf(this.db.db, runId, deviceId),
    ]);
    const policyOf = (tier: SandboxTier | null) =>
      effectiveSandboxPolicy(this.config.get().sandbox, settings, tier);
    const summary = localPolicyOf(row.local_policy);
    const s = sandboxStateOf(policyOf, {
      source: row.source,
      tier: row.tier,
      features: deviceFeaturesOf(row.features),
      policy: summary,
    });
    let tier = s.effectiveTier;
    let networkOff = policyOf(s.tier).base.egress === "none";
    if (row.source === "cloud") {
      const state = await this.sandbox.limitsState({ orgId, deviceId });
      if (state.pendingFilesReset && state.applied !== null) {
        tier = state.applied.tier;
        networkOff = state.applied.egress === "none";
      }
    } else if (unattended !== null && !unattended.openGranted) {
      tier = minTier(tier, "dev");
    }
    return {
      tier,
      isolation: tier === "open" ? s.isolation : "sandbox",
      ...(networkOff && { network: "none" as const }),
      ...(row.source === "local" &&
        summary !== null && { localhost: summary.localhost, unixSockets: summary.unixSockets }),
      ...(unattended !== null && { unattended: true as const }),
    };
  }

  /** Renames the device locked by {@link lockOwn} (`before`); see {@link rename}. */
  private async renameLocked(
    orgId: string,
    accountId: string,
    id: string,
    before: { name: string | null },
    name: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (before.name === name) return;
    // the same name in another case is this device's own: the index allows it
    if (before.name?.toLowerCase() !== name.toLowerCase()) {
      await this.assertNameFree(orgId, accountId, name);
    }
    try {
      await this.db
        .updateTable("devices")
        .set({ name, demoted_from_provider: null, updated_at: sql<Date>`now()` })
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
   * The owner changes one of their own devices' local policy (network ask-to-allow spec §7, §13
   * Q6; sandbox dev tiers spec §7.3): sent to the machine with the `policy` op, which is the
   * authority and answers with the policy as written. Anyone but the owner gets
   * `device.not_found`. A `tier` above the device's ceiling → `device.tier_not_allowed`. A widening
   * change (`add`; a `tier` that may raise the machine's, judged as the machine judges it) is
   * refused up front with `device.policy_refused` when the machine last reported
   * `remoteGrants: "off"` (otherwise the machine decides); narrowing is always sent, and
   * `isolation` is only ever `sandbox`. The machine offline → `device.offline`; a cloud device or a
   * program without the `policyOp` feature → `device.policy_unsupported`; the machine's refusal →
   * `device.policy_refused` with its message. Callers are human sessions only (no personal access
   * token, no service token, no Platform op).
   */
  async changePolicy(
    orgId: string,
    account: { id: string; displayName: string },
    id: string,
    change: DevicePolicyChange,
  ): Promise<DeviceLocalPolicySummary> {
    await this.access.usable(orgId, account.id, id);
    if (change.tier !== undefined && change.tier !== null) {
      const policy = await this.policyFor(orgId, change.tier);
      if (!tierAtMost(change.tier, policy.ceiling)) throw tierNotAllowed(change.tier, policy);
    }
    const summary = await this.policies.summary(id);
    const known = summary?.policy ?? null;
    const widens =
      (change.add?.length ?? 0) > 0 || (known !== null && tierWidens(known.tier, change.tier));
    // only a known "off" is refused here; an unknown summary, a machine that cannot take the op
    // or none at all are left to apply (the machine decides, or unsupported / offline)
    const canApply = summary?.features.includes("policyOp") === true;
    if (widens && canApply && known?.remoteGrants === "off") {
      throw new ApiError("device.policy_refused", remoteGrantsOffMessage(change));
    }
    const out = await this.policies.apply({
      orgId,
      deviceId: id,
      change: {
        ...(change.add !== undefined && { add: change.add }),
        ...(change.remove !== undefined && { remove: change.remove }),
        ...(change.tier !== undefined && { tier: change.tier }),
        ...(change.isolation !== undefined && { isolation: change.isolation }),
      },
      source: { accountId: account.id, accountName: account.displayName, via: "web" },
    });
    if (out.applied) return out.policy;
    if (out.reason === "offline") throw new ApiError("device.offline", out.message);
    if (out.reason === "unsupported") {
      throw new ApiError("device.policy_unsupported", out.message);
    }
    throw new ApiError("device.policy_refused", out.message);
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
   * item 13) is stranded: it is demoted (marked with the provider it was demoted from; the UI
   * names it 「个人设备（<provider display name>）」) and stays listed as unavailable and deletable.
   * Its replacement is the person's former default demoted from the current provider when there
   * is one (switching back restores it, with its files), else a fresh default. A live default
   * not in use yet (no healthy files, no instance, none being created: {@link inUseForDefault})
   * is likewise swapped for a former default holding healthy files at the current provider; it is
   * demoted (from the provider it was made under) so it can come back in turn. A former default
   * belongs to the provider holding its resources once it holds any, else to the one it was
   * demoted from ({@link demotedProvider}), so one swapped out empty and used afterwards is
   * labelled and restored by where its files are.
   * All of it in one transaction: switching back and forth never adds devices.
   *
   * Replacing one first takes the person's membership row (`FOR SHARE`, after the org row), so an
   * offboarding that removes them cannot leave a live default behind; not a member (any more) →
   * `org.not_found`. Idempotent under concurrency: the live default row and the person's former
   * defaults of the current provider are locked (`FOR NO KEY UPDATE`) and the live default re-read
   * after them, the partial unique index on the live default makes a racing insert do nothing, and
   * the select that follows reads the winner. Needs a current sandbox provider
   * (`device.unavailable`). It is the person's baseline, so it is created even at
   * `devices.maxPersonal`.
   */
  async ensureDefault(orgId: string, accountId: string): Promise<string> {
    const live = await this.defaultOf(orgId, accountId);
    if (live && !this.stranded(live)) {
      const current = this.providers.cloud()?.plugin;
      if (inUseForDefault(live) || current === undefined) return live.id;
      const former = await this.formerDefaults(orgId, accountId, current);
      if (!former.some((f) => f.holdsFiles)) return live.id;
    }
    return this.insertDefault(orgId, accountId);
  }

  @Transactional()
  private async insertDefault(orgId: string, accountId: string): Promise<string> {
    const current = this.providers.cloud();
    if (!current) throw deviceUnavailable(null);
    await this.lockMember(orgId, accountId, "share");
    const locked = await this.defaultOf(orgId, accountId, true);
    const former = await this.formerDefaults(orgId, accountId, current.plugin, true);
    // a racing replacement committed while this waited: its default is the answer
    const live = locked ?? (await this.defaultOf(orgId, accountId));
    if (live && live !== locked) return live.id;
    const stranded = live !== undefined && this.stranded(live);
    const withFiles = former.find((f) => f.holdsFiles);
    if (live && !stranded && (inUseForDefault(live) || withFiles === undefined)) return live.id;
    // a default is needed (none, or a stranded one): any former default will do, files first
    const restore = withFiles ?? (live === undefined || stranded ? former[0] : undefined);
    if (live) {
      const from = stranded
        ? (deviceProvider(live, current.plugin) ?? "unknown")
        : (live.provider ?? current.plugin);
      await this.demote(live.id, from);
    }
    if (restore) {
      await this.db
        .updateTable("devices")
        .set({ is_default: true, demoted_from_provider: null, updated_at: sql<Date>`now()` })
        .where("id", "=", restore.id)
        .execute();
      return restore.id;
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
   * Turns the live default into an ordinary device marked as demoted from `provider`; a name
   * the person gave it stays. Runs under the person's membership lock and the default row's lock,
   * before any other row becomes the default (the partial unique index).
   */
  private async demote(id: string, provider: string): Promise<void> {
    await this.db
      .updateTable("devices")
      .set({ is_default: false, demoted_from_provider: provider, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * The person's live former defaults of `provider` ({@link demotedProvider}: files or an instance
   * kept by `provider`, or none and demoted from it), the ones holding healthy files first (lost
   * files count as none), then the most recently used, then the most recently demoted. `lock`
   * takes their rows (`FOR NO KEY UPDATE`, in id order, so racing replacements queue on the same
   * rows).
   */
  private async formerDefaults(
    orgId: string,
    accountId: string,
    provider: string,
    lock = false,
  ): Promise<{ id: string; holdsFiles: boolean }[]> {
    const rows = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select([
        "e.id",
        "e.provider",
        "e.updated_at",
        "i.provider as instance_provider",
        "i.fs_status",
        "e.demoted_from_provider",
        "i.handle",
        "i.status",
        "i.last_used_at",
      ])
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.is_default", "=", false)
      .where("e.demoted_from_provider", "is not", null)
      .where((eb) =>
        eb.or([eb("e.demoted_from_provider", "=", provider), eb("i.provider", "=", provider)]),
      )
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
        return {
          r,
          holdsFiles: inUseForDefault({ ...facts, status: r.status }),
          belongs: demotedProvider(r.demoted_from_provider, facts) === provider,
        };
      })
      .filter(({ belongs }) => belongs)
      .sort(
        (a, b) =>
          Number(b.holdsFiles) - Number(a.holdsFiles) ||
          time(b.r.last_used_at) - time(a.r.last_used_at) ||
          time(b.r.updated_at) - time(a.r.updated_at),
      )
      .map(({ r, holdsFiles }) => ({ id: r.id, holdsFiles }));
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
  ): Promise<(ProviderFacts & { id: string; status: InstanceStatus | null }) | undefined> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select([
        "e.id",
        "e.provider",
        "i.provider as instance_provider",
        "i.fs_status",
        "i.handle",
        "i.status",
      ])
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
        status: row.status,
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
    // all of them even for one `id`: a former default's ordinal counts its siblings
    const all = await this.db
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
        "e.demoted_from_provider",
        "e.tier",
        "e.created_at",
        "m.id as machine_id",
        "m.name as machine_name",
        "m.os as machine_os",
        "m.mode as machine_mode",
        "m.program_version as machine_program_version",
        "m.last_seen_at as machine_last_seen_at",
        "m.session_isolation as machine_session_isolation",
        "m.features as machine_features",
        "m.local_policy as machine_local_policy",
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
    const factsOf = (r: (typeof all)[number]): ProviderFacts => ({
      provider: r.provider,
      instanceProvider: r.instance_provider,
      fsStatus: r.fs_status,
      hasInstance: r.handle !== null,
    });
    // a former default is labelled after the provider holding its resources, else its marker
    const demoted = new Map(
      all.map((r) => [r.id, demotedProvider(r.demoted_from_provider, factsOf(r))]),
    );
    const ordinals = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const r of [...all].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
    )) {
      const from = demoted.get(r.id) ?? null;
      if (from === null || r.name !== null) continue;
      const n = (seen.get(from) ?? 0) + 1;
      seen.set(from, n);
      ordinals.set(r.id, n);
    }
    const demotedProviders = [
      ...new Set(rows.flatMap((r) => (demoted.get(r.id) ? [demoted.get(r.id) as string] : []))),
    ];
    const [names, recent, settings] = await Promise.all([
      this.displayNames.many(demotedProviders),
      this.recentSandboxChanges(
        orgId,
        rows.map((r) => r.id),
      ),
      readOrgSettings(this.db.db, orgId),
    ]);
    const policyOf = (tier: SandboxTier | null) =>
      effectiveSandboxPolicy(this.config.get().sandbox, settings, tier);
    // each device's limits (a cloud device's own tier) and its instance's pending change
    const perDevice = new Map(
      await Promise.all(
        rows.map(async (r) => {
          const policy = policyOf(r.source === "cloud" ? r.tier : null);
          const [limits, state] = await Promise.all([
            this.sandbox.deviceLimits({ orgId, deviceId: r.id }, { policy }),
            r.source === "cloud"
              ? this.sandbox.limitsState({ orgId, deviceId: r.id })
              : { pendingNextUse: false, pendingFilesReset: false },
          ]);
          return [r.id, { limits, state }] as const;
        }),
      ),
    );
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
      const provider = deviceProvider(factsOf(r), current);
      const live = (r.status === "running" || r.status === "suspended") && r.last_used_at;
      const from = demoted.get(r.id) ?? null;
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
        network:
          r.source === "local" && r.machine_id !== null
            ? {
                features: deviceFeaturesOf(r.machine_features),
                policy: localPolicyOf(r.machine_local_policy),
              }
            : null,
        sandbox: {
          ...sandboxStateOf(policyOf, {
            source: r.source,
            tier: r.tier,
            features: r.machine_id === null ? [] : deviceFeaturesOf(r.machine_features),
            policy: r.machine_id === null ? null : localPolicyOf(r.machine_local_policy),
          }),
          pendingNextUse: perDevice.get(r.id)?.state.pendingNextUse ?? false,
          pendingFilesReset: perDevice.get(r.id)?.state.pendingFilesReset ?? false,
          recent: recent.get(r.id) ?? [],
        },
        // a local device's machine decides it; cloud devices have none in phase 2
        sessionIsolation: r.machine_session_isolation ?? false,
        filesLost: r.fs_status === "lost",
        instance: live
          ? {
              status: r.status as "running" | "suspended",
              lastUsedAt: (r.last_used_at as Date).toISOString(),
            }
          : null,
        limits: limitsView(perDevice.get(r.id)?.limits as SandboxLimits),
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /**
   * The last {@link RECENT_POLICY_CHANGES} sandbox changes of each device in the org (audit rows
   * `device.policy_changed`, `device.tier_changed`, `device.isolation_reported`), newest first,
   * with the deciding account's display name.
   */
  private async recentSandboxChanges(
    orgId: string,
    deviceIds: string[],
  ): Promise<Map<string, DeviceSandboxChangeView[]>> {
    const out = new Map<string, DeviceSandboxChangeView[]>();
    if (deviceIds.length === 0) return out;
    const ranked = this.db
      .selectFrom("audit_events as a")
      .select([
        "a.target",
        "a.action",
        "a.at",
        "a.detail",
        "a.actor_account_id",
        sql<number>`row_number() OVER (PARTITION BY a.target ORDER BY a.at DESC, a.id DESC)`.as(
          "n",
        ),
      ])
      .where("a.org_id", "=", orgId)
      .where("a.action", "in", [...SANDBOX_CHANGE_ACTIONS])
      .where("a.target", "in", deviceIds);
    const rows = await this.db
      .selectFrom(ranked.as("r"))
      .leftJoin("accounts as ac", "ac.id", "r.actor_account_id")
      .select(["r.target", "r.action", "r.at", "r.detail", "ac.display_name"])
      .where("r.n", "<=", RECENT_POLICY_CHANGES)
      .orderBy("r.at", "desc")
      .execute();
    for (const r of rows) {
      if (r.target === null) continue;
      const list = out.get(r.target) ?? [];
      list.push(
        sandboxChangeOf(
          r.action,
          r.at,
          (r.detail ?? {}) as Record<string, unknown>,
          r.display_name ?? null,
        ),
      );
      out.set(r.target, list);
    }
    return out;
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
  ): Promise<{
    name: string | null;
    is_default: boolean;
    source: "cloud" | "local";
    tier: SandboxTier | null;
  }> {
    await this.lockMember(orgId, accountId);
    const row = await this.db
      .selectFrom("devices")
      .select(["name", "is_default", "source", "tier"])
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

/** A copy of `l` for a view (its lists not shared). */
const limitsView = (l: SandboxLimits): SandboxLimits => ({
  ...l,
  allowHosts: [...l.allowHosts],
  devHosts: [...l.devHosts],
});

/** The audit actions a device's recent sandbox changes list. */
const SANDBOX_CHANGE_ACTIONS = [
  "device.policy_changed",
  "device.tier_changed",
  "device.isolation_reported",
] as const;

const tierOrNull = (v: unknown): SandboxTier | null =>
  v === "strict" || v === "dev" || v === "open" ? v : null;

/** One audit row of {@link SANDBOX_CHANGE_ACTIONS} as a {@link DeviceSandboxChangeView}. */
function sandboxChangeOf(
  action: string,
  at: Date,
  d: Record<string, unknown>,
  by: string | null,
): DeviceSandboxChangeView {
  const hosts = (v: unknown) =>
    Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
  const isolation = d.isolation === "sandbox" || d.isolation === "none" ? d.isolation : null;
  const base = { at: at.toISOString(), add: [], remove: [], tier: null, isolation: null, by };
  if (action === "device.tier_changed") {
    return { ...base, kind: "tier", tier: { to: tierOrNull(d.to) }, via: "web", confirmed: true };
  }
  if (action === "device.isolation_reported") {
    return { ...base, kind: "isolation", isolation, via: "device", confirmed: true };
  }
  return {
    ...base,
    kind: "policy",
    add: hosts(d.add),
    remove: hosts(d.remove),
    // the key is there only when the change set the tier (null: follow the org's default)
    tier: "tier" in d ? { to: tierOrNull(d.tier) } : null,
    isolation,
    via: d.via === "im" ? "im" : "web",
    confirmed: d.confirmed === true,
  };
}

/** What {@link sandboxStateOf} reads of a device. */
export interface DeviceSandboxFacts {
  source: "cloud" | "local";
  /** A cloud device's stored tier (ignored for a local device). */
  tier: SandboxTier | null;
  /** A local device's connected machine's features ([] when none is connected). */
  features: readonly DeviceFeature[];
  /** A local device's policy summary as last reported (null when unknown or none connected). */
  policy: DeviceLocalPolicySummary | null;
}

/**
 * A device's sandbox level (spec §4.2, §4.4): its chosen tier (a cloud device's stored one, a
 * local device's reported one) under the org's policy (`policyOf`). A local device whose program
 * lacks the `tiers` feature runs `strict` (it ignores the tier the kernel sends); it runs without
 * a sandbox only when it reports `isolation: "none"` and its effective tier is `open` (the device
 * keeps the sandbox at any lower tier).
 */
export function sandboxStateOf(
  policyOf: (tier: SandboxTier | null) => EffectiveSandboxPolicy,
  d: DeviceSandboxFacts,
): Omit<DeviceSandboxView, "pendingNextUse" | "pendingFilesReset" | "recent"> {
  const chosen = d.source === "cloud" ? d.tier : (d.policy?.tier ?? null);
  const p = policyOf(chosen);
  const tiersKnown = d.source === "cloud" || d.features.includes("tiers");
  const effectiveTier = tiersKnown ? p.tier : "strict";
  return {
    tier: chosen,
    effectiveTier,
    ceiling: p.ceiling,
    cappedBy: tiersKnown ? p.cappedBy : null,
    defaultTier: p.defaultTier,
    allowUnsandboxed: p.allowUnsandboxed,
    isolation:
      d.source === "local" && d.policy?.isolation === "none" && effectiveTier === "open"
        ? "none"
        : "sandbox",
  };
}

/**
 * Whether setting a local device's tier to `next` (null: follow the org's default) may raise it,
 * not knowing the org's default at the machine: a tier above the reported one, any tier but
 * `strict` when it reports none, and following the default when it reports `strict` or `dev`.
 */
export function tierWidens(
  reported: SandboxTier | undefined,
  next: SandboxTier | null | undefined,
): boolean {
  if (next === undefined || next === "strict") return false;
  if (next === null) return reported !== undefined && reported !== "open";
  return reported === undefined || !tierAtMost(next, reported);
}

/** A tier above the device's ceiling: which ceiling, and the highest tier allowed. */
function tierNotAllowed(tier: SandboxTier, policy: EffectiveSandboxPolicy): ApiError {
  const platform = policy.cappedBy === "platform";
  return new ApiError(
    "device.tier_not_allowed",
    `${platform ? "The platform" : "Your organization"} allows sandbox levels up to ${policy.ceiling}; this device cannot be set to ${tier}.`,
  );
}

/**
 * The refusal of a widening change on a device whose machine reported `remoteGrants: "off"`: the
 * command to run on the machine instead.
 */
function remoteGrantsOffMessage(change: DevicePolicyChange): string {
  const local = [
    ...(change.add !== undefined && change.add.length > 0
      ? [`capybara-device policy add allowedDomains ${change.add.join(",")}`]
      : []),
    ...(change.tier !== undefined
      ? [`capybara-device policy set tier ${change.tier ?? "default"}`]
      : []),
  ];
  return `This device does not accept widening changes from the deployment; change it on the machine: ${local.join("; ")}`;
}
