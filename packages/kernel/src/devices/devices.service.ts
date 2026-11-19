import { randomUUID } from "node:crypto";
import type {
  DeviceLocalPolicySummary,
  DeviceOwnerCeilingNarrowing,
  LocalizedName,
  SandboxBrowseScope,
  SandboxLimits,
  SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { SandboxOperationIntentsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  assertNotSharedAdmission,
  TransactionHost,
  withOrderedLocks,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { DevicePolicyService } from "../local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../local-devices/keys.js";
import { MachinesService } from "../local-devices/machines.js";
import { type OwnerFacts, ownerFactsOf } from "../local-devices/owner-report.js";
import { deviceFeaturesOf, localPolicyOf } from "../local-devices/policy-summary.js";
import type { DeviceModeLevel } from "../runtime/context/device-paths.js";
import type {
  DeviceSandbox,
  DeviceSandboxLayer,
  HostGrantCeiling,
} from "../sandbox/device-sandbox.js";
import { hostGrantable } from "../sandbox/device-sandbox.js";
import { oweDeviceDestroy, SandboxJobs } from "../sandbox/jobs.js";
import {
  coversHost,
  type DeviceLimits,
  type DeviceNetwork,
  projectReachOf,
} from "../sandbox/modes.js";
import {
  hostsNarrowed,
  needsOpenNetwork,
  PermissionCeilingWrites,
} from "../sandbox/permission-ceiling-writes.js";
import { cloudOwnNetwork, networkOfSandbox, PermissionFacts } from "../sandbox/permission-facts.js";
import { isInternalProvider, LOCAL_PROVIDER, SandboxProviders } from "../sandbox/providers.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
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
  /** Its effective device sandbox, the same under every permission profile. */
  sandbox: DeviceSandboxView;
  /**
   * A local device's owner ceiling as its machine last reported it (read only): an authenticated
   * report (`state: "report"`), a stale or conflicting one (`blocked`) or nothing readable
   * (`missing`). `stale` is true while the machine is offline or the report is not current:
   * last-known facts, never authority. null for a cloud device (it has no machine) and for a local
   * one without a connected machine.
   */
  ownerCeiling: DeviceOwnerCeilingView | null;
  /**
   * A cloud device whose B1 snapshot found applied limits it could not establish exactly: nothing
   * runs on it until a file reset establishes them (`device.permission_reconcile_required` at
   * admission). Always false for a local device.
   */
  reconcileRequired: boolean;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /**
   * Its sandbox limits: the resources and network a cloud instance is created with; for a local
   * device the network its commands carry (the machine intersects it with its owner's ceiling).
   */
  limits: SandboxLimits;
  createdAt: string;
}

/**
 * The effective device sandbox of a device as its owner sees it (approval-only profiles design,
 * "Settings model" and "UI"): `effectiveDeviceSandbox` over the platform, org, device and provider
 * layers.
 */
export interface DeviceSandboxView {
  /** The sandbox network in effect: the open public internet, the allowlist, or closed. */
  network: "open" | "allowlist" | "none";
  /** The widest network the platform, the org and the provider leave this device. */
  networkCeiling: "open" | "allowlist" | "none";
  /** The allowlist hosts in effect (empty unless {@link network} is `allowlist`). */
  hosts: string[];
  /**
   * The device's own network setting: a cloud device's stored choice (null follows its org), a
   * local owner's reported network (null without a readable report).
   */
  ownNetwork: "open" | "allowlist" | "none" | null;
  /**
   * The device's own host list, which only narrows the org's hosts: a local owner's
   * `allowedDomains` (its machine's ceiling while its network is the allowlist), a cloud device's
   * stored hosts (empty: it follows its org's hosts).
   */
  allowedDomains: string[];
  /** Whether a call may be granted escalation outside the sandbox (never on a cloud device). */
  outsideSandbox: boolean;
  /** How far restricted work may root outside the workspace. */
  restrictedProjectReach: "workspace" | "os-user";
  /** The layer that set each ceiling (a disabled option names it), or null when nothing did. */
  layer: { network: DeviceSandboxLayer | null; outsideSandbox: DeviceSandboxLayer | null };
  /**
   * A cloud device's instance runs another network: its next use updates or recreates it, files
   * kept (the page says it applies on next use).
   */
  pendingNextUse: boolean;
  /**
   * Its provider applies limits at its file system (`limitsApplyAt: "fileSystem"`) and the instance
   * runs another network: only a file reset applies it (the page says it applies after a reset).
   */
  pendingFilesReset: boolean;
  /** Its last {@link RECENT_POLICY_CHANGES} setting changes, newest first. */
  recent: DeviceSettingChangeView[];
}

/** {@link DeviceView.ownerCeiling}: a local machine's owner ceiling as reported. */
export interface DeviceOwnerCeilingView {
  state: "report" | "blocked" | "missing";
  revision: string | null;
  sequence: number | null;
  /** The owner allows running outside the sandbox (fail closed: false). */
  outsideSandbox: boolean;
  /** The owner's sandbox network (fail closed: `allowlist`). */
  network: "open" | "allowlist";
  /** The owner's sandbox allowlist: the machine's host ceiling while its network is `allowlist`. */
  allowedDomains: string[];
  restrictedProjectReach: "workspace" | "os-user";
  observedAt: string | null;
  stale: boolean;
}

/** How many recent setting changes a device view lists. */
export const RECENT_POLICY_CHANGES = 10;

/**
 * One setting change of a device, as its owner sees it on the device page:
 * - `policy` (`device.policy_changed`): hosts removed from a local machine's allowlist by the
 *   platform (`web`, `im`), or added or removed on the machine by its owner (`device`,
 *   `capybara-device policy ...`); one sent whose answer never came (`device.policy_unknown`) or
 *   that failed (`device.policy_failed`) too;
 * - `ceiling` (`device.owner_ceiling_changed`): a machine's owner ceiling changed, narrowed from the
 *   device page (`web`) or on the machine (`device`);
 * - `network` (`device.network_changed`): a cloud device's sandbox network changed on its device
 *   page (`web`), through an API token (`token`), or by an agent's Platform tool call (`agent`).
 */
export interface DeviceSettingChangeView {
  at: string;
  kind: "policy" | "ceiling" | "network";
  /** Hosts added to / removed from the local allowlist (`policy` only; else empty). */
  add: string[];
  remove: string[];
  /** The owner ceiling change (`ceiling` only; else null). `from` is null when the row does not say. */
  ceiling: { from: DeviceCeilingFacts | null; to: DeviceCeilingFacts } | null;
  /** The cloud network change (`network` only; else null). */
  network: { from: DeviceNetworkSetting; to: DeviceNetworkSetting } | null;
  /** The deciding account's display name (null when the account is gone). */
  by: string | null;
  /**
   * `device`: made or reported on the machine itself; `token`: through an API token; `agent`: an
   * agent's Platform tool call.
   */
  via: "web" | "im" | "device" | "token" | "agent";
  /**
   * What became of a `policy` change sent to the machine: `applied` (also every change made or
   * reported on the machine, and every other row); `unknown`, its answer never came, `failed`, the
   * machine refused it, never received it or stopped while applying it.
   */
  outcome: "applied" | "unknown" | "failed";
}

/** One side of a {@link DeviceSettingChangeView.ceiling} change. */
export interface DeviceCeilingFacts {
  outsideSandbox: boolean;
  restrictedProjectReach?: "workspace" | "os-user";
  network?: "open" | "allowlist";
}

/** A cloud device's stored network setting: `mode` null follows its org. */
export interface DeviceNetworkSetting {
  mode: "open" | "allowlist" | "none" | null;
  hosts: string[];
}

/** A narrowing of a local device's policy by its owner (`POST /devices/:id/policy`). */
export interface DevicePolicyChange {
  remove?: string[] | undefined;
  /** Narrow the owner ceiling (never widen; the schema refuses anything wider). */
  ownerCeiling?:
    | {
        outsideSandbox?: false | undefined;
        network?: "allowlist" | undefined;
        restrictedProjectReach?: "workspace" | undefined;
      }
    | undefined;
}

/** What `PATCH /devices/:id` changes. */
export interface DevicePatch {
  name?: string;
  /**
   * A cloud device's sandbox network, within its org's and the platform's ceilings. A local
   * device refuses it here (`device.ceiling_on_machine`).
   */
  network?: { mode: "open" | "allowlist" | "none" | null; hosts?: string[] | undefined };
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
 * `device.not_found`). Deleting one soft-deletes it and owes the destruction of its instance and
 * files (a `sandbox-destroy-for` job) in the same transaction.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "devicePolicy" | "deviceLimits" | "limitsState">,
    @Inject(SandboxJobs) private readonly sandboxJobs: Pick<SandboxJobs, "resetFiles">,
    /** Owes a deleted device's destruction in the delete's transaction. */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
    /** Reads the device relay's lease (`online`). */
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
    @Inject(MachinesService)
    private readonly machines: Pick<MachinesService, "revoke" | "revokeActive">,
    @Inject(DevicePolicyService)
    private readonly policies: Pick<DevicePolicyService, "apply" | "summary">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Inject(PermissionFacts)
    private readonly facts: Pick<PermissionFacts, "deviceSandbox" | "deviceSandboxFacts">,
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
   * `PATCH /devices/:id`: renames one of the person's live devices ({@link rename}) and sets a
   * cloud device's sandbox network ({@link networkLocked}), in one transaction. A network change
   * takes the membership, the device row and the device's permission write lock as the ordered
   * prelude (`withOrderedLocks`): inside a run's fence (`devices.set-network`) they follow the org
   * row and precede the conversation rows. A local device's network lives on its machine
   * (`device.ceiling_on_machine`). `narrowOnly` (an API token, the Platform tool): the network may
   * only narrow, stored and effective.
   */
  async update(
    orgId: string,
    accountId: string,
    id: string,
    patch: DevicePatch,
    actorTokenId?: string,
    opts: { narrowOnly?: boolean; auditDetail?: Record<string, unknown> } = {},
  ): Promise<DeviceView> {
    if (patch.network !== undefined)
      await withOrderedLocks(
        () => this.lockNetworkSubject(orgId, accountId, id),
        () => this.updateIn(orgId, accountId, id, patch, actorTokenId, opts),
      );
    else await this.updateIn(orgId, accountId, id, patch, actorTokenId, opts);
    return this.get(orgId, accountId, id);
  }

  /** The prelude of a network change: the membership, the device row, the device's write lock. */
  @Transactional({ propagation: "mandatory" })
  private async lockNetworkSubject(orgId: string, accountId: string, id: string): Promise<void> {
    await this.lockOwn(orgId, accountId, id);
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    accountId: string,
    id: string,
    patch: DevicePatch,
    actorTokenId: string | undefined,
    opts: { narrowOnly?: boolean; auditDetail?: Record<string, unknown> },
  ): Promise<void> {
    // held since the prelude for a network change (naming them again re-checks)
    const before = await this.lockOwn(orgId, accountId, id);
    if (patch.network !== undefined)
      await this.networkLocked(orgId, accountId, id, before, patch.network, actorTokenId, opts);
    if (patch.name !== undefined) {
      await this.renameLocked(
        orgId,
        accountId,
        id,
        before,
        patch.name,
        actorTokenId,
        opts.auditDetail,
      );
    }
  }

  /**
   * Checks a cloud network change without writing anything and without locks (the Platform
   * tool's precheck): the device is the person's live cloud device, and the change stays within
   * the ceilings and, with `narrowOnly`, only narrows. Throws what {@link update} would; the
   * write re-checks under its locks.
   */
  async checkNetwork(
    orgId: string,
    accountId: string,
    id: string,
    network: NonNullable<DevicePatch["network"]>,
    narrowOnly: boolean,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("devices")
      .select(["source"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    await this.planNetwork(orgId, id, row, network, narrowOnly);
  }

  /**
   * Decides a cloud network change (read only): the stored setting before and after, the
   * effective device sandbox before and after (computed in memory from the patched setting), and
   * whether it widens. Refuses, without writing: a local device (`device.ceiling_on_machine`),
   * the open network above the ceilings or a host outside the org's list
   * (`device.network_not_allowed`), and with `narrowOnly` a widening of the stored setting or of
   * the effective network (`device.network_not_allowed`). Null when nothing changes.
   */
  private async planNetwork(
    orgId: string,
    id: string,
    before: { source: string },
    want: NonNullable<DevicePatch["network"]>,
    narrowOnly: boolean,
  ) {
    if (before.source !== "cloud")
      throw new ApiError(
        "device.ceiling_on_machine",
        "This device's sandbox network is kept on its connected machine: narrow it from the device page, or widen it on that machine with capybara-device ceiling set --network open or capybara-device policy add allowedDomains <host>.",
      );
    const row = await this.db
      .selectFrom("devices")
      .select(["network_mode", "network_hosts"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const own = cloudOwnNetwork(row);
    const from: DeviceNetworkSetting = { mode: own.networkMode, hosts: [...own.networkHosts] };
    const to: DeviceNetworkSetting = {
      mode: want.mode,
      hosts:
        want.mode === "allowlist"
          ? [...new Set((want.hosts ?? []).map((h) => h.toLowerCase()))].sort()
          : [],
    };
    if (from.mode === to.mode && sameHosts(from.hosts, to.hosts)) return null;
    const [prev, next] = await Promise.all([
      this.facts.deviceSandboxFacts(orgId, id),
      this.facts.deviceSandboxFacts(orgId, id, undefined, {
        networkMode: to.mode,
        networkHosts: to.hosts,
      }),
    ]);
    if (to.mode === "open" && next.box.networkMode !== "open")
      throw new ApiError(
        "device.network_not_allowed",
        `The open network is not allowed for this device: ${networkLayerText(next.box.layer.network)} limits it to ${next.box.networkCeiling === "none" ? "no network" : "the allowlist"}`,
      );
    // a device's own list only narrows its org's hosts, whatever the network in effect now
    const outside = to.hosts.filter(
      (h) => !next.orgHosts.some((p) => coversHost(p.toLowerCase(), h)),
    );
    if (outside.length > 0)
      throw new ApiError(
        "device.network_not_allowed",
        `A device's host list only narrows its organization's hosts; an organization admin adds ${outside.join(", ")} to the organization's device network list`,
      );
    const widened = networkWidens(prev.box, next.box);
    if (narrowOnly && (widened || storedNetworkWidens(from, to)))
      throw new ApiError(
        "device.network_not_allowed",
        "Through an API token or the Platform tool a device's network may only narrow (to allowlist, its own shorter host list, or none; never back to following the organization); its owner widens it on the device page",
      );
    return { from, to, next, widened };
  }

  /**
   * A cloud device's sandbox network (approval-only profiles design, "Settings model"), under the
   * device authority writer held since the prelude: its owner chooses `open`, `allowlist` (its
   * org's hosts, narrowed by its own list: a device list never adds a host; an empty one follows
   * the org's hosts), `none` (closed) or null (follow the org), in both directions within the
   * org's and the platform's ceilings ({@link planNetwork}). The write and its publication are one
   * transaction: a narrowing bumps the device epoch and revokes the admitted or started work it
   * takes ({@link networkNarrowingRevokes}; the revocations are owed through the outbox) and keeps
   * Full consent; a widening resets Full consent with a `permission_profile_changed` event.
   * Audited `device.network_changed` (`via`: `web`, `token` for an API token, or the agent's).
   */
  private async networkLocked(
    orgId: string,
    accountId: string,
    id: string,
    before: { source: string },
    want: NonNullable<DevicePatch["network"]>,
    actorTokenId: string | undefined,
    opts: { narrowOnly?: boolean; auditDetail?: Record<string, unknown> },
  ): Promise<void> {
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
    const plan = await this.planNetwork(orgId, id, before, want, opts.narrowOnly === true);
    if (plan === null) return;
    const { from, to, next, widened } = plan;
    await this.db
      .updateTable("devices")
      .set({
        network_mode: to.mode,
        network_hosts: JSON.stringify(to.hosts),
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .execute();
    await this.ceilings.publishLocked(
      { orgId, deviceId: id },
      "device",
      (scope, intent) => networkNarrowingRevokes(next, scope, intent),
      widened,
    );
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.network_changed",
      target: id,
      detail: {
        from,
        to,
        by: accountId,
        via: actorTokenId !== undefined ? "token" : "web",
        ...opts.auditDetail,
      },
    });
  }

  /**
   * How far restricted work may root outside the device's workspace now (B2): a local machine's
   * owner reach within a platform and org that allow the wider device ceiling; a cloud device
   * keeps its previous rule (its effective mode). Never the owner's Full permission alone.
   */
  async projectReach(orgId: string, deviceId: string): Promise<"workspace" | "os-user"> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.source", "m.owner_report", "m.local_policy"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return "workspace";
    const policy = await this.sandbox.devicePolicy({ orgId, deviceId });
    return projectReachOf(
      row.source,
      policy,
      row.source === "local" ? ownerFactsOf(row).restrictedProjectReach : null,
    );
  }

  /**
   * The level a sandbox call in the device runs at now, for the model (legacy `device_paths`, auto
   * mode spec §4.2): the kernel-internal tier (`SandboxMode`: a local machine's owner permission to
   * run outside the sandbox, failing closed) with its device sandbox network, and a cloud device's
   * pending file-reset state (the tier and network its instance still runs with). Null when the
   * device is not a live device of the org.
   */
  async modeLevel(orgId: string, deviceId: string): Promise<DeviceModeLevel | null> {
    const row = await this.db
      .selectFrom("devices")
      .select(["source"])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const policy = await this.sandbox.devicePolicy({ orgId, deviceId });
    let mode = policy.mode;
    let network: DeviceNetwork =
      row.source === "local"
        ? networkOfSandbox(await this.facts.deviceSandbox(orgId, deviceId))
        : policy.network;
    if (row.source === "cloud") {
      const state = await this.sandbox.limitsState({ orgId, deviceId }, { policy });
      if (state.pendingFilesReset) {
        // an unknown record (an instance made before auto mode) may be wider than the effective
        // limits: tell the model the widest, never a narrower network than it may reach
        mode = state.applied === null ? "auto" : state.applied.mode;
        network =
          state.applied === null ? { kind: "open-public", hosts: [] } : state.applied.network;
      }
    }
    return { mode, allowedMode: policy.allowedMode, network, local: row.source === "local" };
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
   * Deletes one of the person's live devices: soft delete, its IM default row cleared, and a
   * `sandbox-destroy-for` job owed in the same transaction (`device-destroy-<deviceId>`; the
   * worker waits for running commands, then destroys the instance and the files). Conversations bound to it keep pointing at it; their
   * sandbox tools then fail with `device.not_found`. A local device's machine is
   * revoked in the same transaction; after the commit it is told `stop { reason: "deleted" }`
   * (while connected) and its connection is closed.
   *
   * The membership, the device row and the device's permission authority lock are the
   * transaction's ordered prelude (`withOrderedLocks`): inside a run's fence (the Platform tool's
   * `devices.delete`) they follow the org row and precede the conversation rows.
   */
  async remove(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    await withOrderedLocks(
      () => this.lockRemovalSubject(orgId, accountId, id),
      () => this.removeIn(orgId, accountId, id, actorTokenId, auditDetail),
    );
  }

  /** The prelude of {@link remove}: the membership, the device row, the device's write lock. */
  @Transactional({ propagation: "mandatory" })
  private async lockRemovalSubject(orgId: string, accountId: string, id: string): Promise<void> {
    await this.lockOwn(orgId, accountId, id);
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
  }

  @Transactional()
  private async removeIn(
    orgId: string,
    accountId: string,
    id: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<void> {
    // held since the prelude (the row and the lock are the same; naming them again re-checks)
    const before = await this.lockOwn(orgId, accountId, id);
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
    await this.ceilings.publishLocked({ orgId, deviceId: id }, "device", true, true);
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
    await oweDeviceDestroy(this.outbox, id, orgId);
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
   * The owner narrows one of their own local devices' sandbox from the web (approval-only
   * profiles design, "Settings model"): sent to the machine with the `policy` op, which is the
   * authority and answers with the policy as written. Anyone but the owner gets
   * `device.not_found`. The owner may remove hosts from the machine's allowlist and narrow its
   * owner ceiling (no running outside the sandbox, the allowlist network, the workspace reach);
   * widening happens on the machine only. The machine offline → `device.offline`; a cloud device
   * or a program without the `policyOpId` feature → `device.policy_unsupported`; the machine's
   * refusal → `device.policy_refused` with its message. Callers are human sessions only (no
   * personal access token, no service token, no Platform op).
   */
  async changePolicy(
    orgId: string,
    account: { id: string; displayName: string },
    id: string,
    change: DevicePolicyChange,
  ): Promise<DeviceLocalPolicySummary> {
    await this.access.usable(orgId, account.id, id);
    const out = await this.policies.apply({
      orgId,
      deviceId: id,
      change: {
        ...(change.remove !== undefined && { remove: change.remove }),
        ...(change.ownerCeiling !== undefined && { ownerCeiling: narrowOnly(change.ownerCeiling) }),
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
      // Two unlocked reads: a swap committed between them leaves `live` demoted and the restored
      // default out of `former`. Only a default still live after `former` is the answer; else
      // the locked path decides.
      if (!former.some((f) => f.holdsFiles)) {
        if ((await this.defaultOf(orgId, accountId))?.id === live.id) return live.id;
      }
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
        "e.network_mode",
        "e.network_hosts",
        "e.permission_reconcile_required",
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
        "m.owner_report as machine_owner_report",
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
    const [names, recent] = await Promise.all([
      this.displayNames.many(demotedProviders),
      this.recentChanges(
        orgId,
        rows.map((r) => r.id),
      ),
    ]);
    // each device's sandbox, limits and its instance's pending change
    const perDevice = new Map(
      await Promise.all(
        rows.map(async (r) => {
          const policy = await this.sandbox.devicePolicy({ orgId, deviceId: r.id });
          const [limits, state, facts] = await Promise.all([
            this.sandbox.deviceLimits({ orgId, deviceId: r.id }, { policy, source: r.source }),
            r.source === "cloud"
              ? this.sandbox.limitsState({ orgId, deviceId: r.id }, { policy })
              : { pendingNextUse: false, pendingFilesReset: false },
            this.facts.deviceSandboxFacts(orgId, r.id),
          ]);
          return [r.id, { limits, state, box: facts.box }] as const;
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
        sandbox: sandboxViewOf(
          perDevice.get(r.id)?.box as DeviceSandbox,
          r.source === "local"
            ? ownerFactsOf({ owner_report: r.machine_owner_report })
            : cloudOwnNetwork(r),
          {
            pendingNextUse: perDevice.get(r.id)?.state.pendingNextUse ?? false,
            pendingFilesReset: perDevice.get(r.id)?.state.pendingFilesReset ?? false,
            recent: recent.get(r.id) ?? [],
          },
        ),
        // a local device's machine decides it; a cloud device has none
        ownerCeiling: ownerCeilingViewOf(r, online.get(r.id) ?? false),
        reconcileRequired: r.source === "cloud" && r.permission_reconcile_required,
        sessionIsolation: r.machine_session_isolation ?? false,
        filesLost: r.fs_status === "lost",
        instance: live
          ? {
              status: r.status as "running" | "suspended",
              lastUsedAt: (r.last_used_at as Date).toISOString(),
            }
          : null,
        limits: limitsView(perDevice.get(r.id)?.limits as DeviceLimits),
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /**
   * The last {@link RECENT_POLICY_CHANGES} setting changes of each device in the org (audit rows
   * {@link SETTING_CHANGE_ACTIONS}), newest first, with the deciding account's display name.
   */
  private async recentChanges(
    orgId: string,
    deviceIds: string[],
  ): Promise<Map<string, DeviceSettingChangeView[]>> {
    const out = new Map<string, DeviceSettingChangeView[]>();
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
      .where("a.action", "in", [...SETTING_CHANGE_ACTIONS])
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
        settingChangeOf(
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
    assertNotSharedAdmission("locking a membership");
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
  }> {
    await this.lockMember(orgId, accountId);
    const row = await this.db
      .selectFrom("devices")
      .select(["name", "is_default", "source"])
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

/** A copy of `l` for a view (its lists not shared; the kernel-internal tier left out). */
const limitsView = (l: DeviceLimits): SandboxLimits => {
  const { mode: _kernelOnly, ...rest } = l;
  return { ...rest, network: { kind: l.network.kind, hosts: [...l.network.hosts] } };
};

const sameHosts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((h, i) => h === b[i]);

const NETWORK_RANK = { none: 0, allowlist: 1, open: 2 } as const;

/**
 * Whether the effective sandbox network widens from `a` to `b`: a wider mode, or an allowlist
 * gaining a host the previous one did not cover.
 */
function networkWidens(
  a: Pick<DeviceSandbox, "networkMode" | "hosts">,
  b: Pick<DeviceSandbox, "networkMode" | "hosts">,
): boolean {
  if (NETWORK_RANK[b.networkMode] !== NETWORK_RANK[a.networkMode])
    return NETWORK_RANK[b.networkMode] > NETWORK_RANK[a.networkMode];
  return (
    b.networkMode === "allowlist" &&
    b.hosts.some((h) => !a.hosts.some((p) => coversHost(p.toLowerCase(), h.toLowerCase())))
  );
}

const STORED_RANK = { none: 0, allowlist: 1, open: 2 } as const;

/**
 * Whether a cloud device's stored network setting widens from `a` to `b`, whatever the network in
 * effect now (a stored widening takes effect when a ceiling opens later): a wider mode, where
 * following the org (null) counts as wider than any explicit mode; or an explicit host list
 * replaced by none of its own (follow the org's hosts) or gaining a host.
 */
export function storedNetworkWidens(a: DeviceNetworkSetting, b: DeviceNetworkSetting): boolean {
  const rank = (m: DeviceNetworkSetting["mode"]) => (m === null ? 3 : STORED_RANK[m]);
  if (rank(b.mode) !== rank(a.mode)) return rank(b.mode) > rank(a.mode);
  if (b.mode !== "allowlist" || a.hosts.length === 0) return false;
  if (b.hosts.length === 0) return true;
  return b.hosts.some((h) => !a.hosts.some((p) => coversHost(p.toLowerCase(), h.toLowerCase())));
}

/**
 * What a cloud device's new network takes from admitted or started work (`next`: its sandbox
 * after the change): open-network work once it is no longer open, and allowlist work naming a host
 * its new hosts no longer cover, unless an independent grant the new per-call ceiling still allows
 * holds it (`hostsNarrowed`).
 */
export function networkNarrowingRevokes(
  next: { box: Pick<DeviceSandbox, "networkMode" | "hosts">; hostCeiling: HostGrantCeiling },
  scope: SandboxOperationScope | SandboxBrowseScope,
  intent: Pick<Selectable<SandboxOperationIntentsTable>, "method" | "granted_hosts">,
): boolean {
  if (next.box.networkMode === "open") return false;
  return (
    needsOpenNetwork(scope) ||
    hostsNarrowed(scope, intent, next.box.hosts, (host) => hostGrantable(next.hostCeiling, host))
  );
}

/** Who set a network ceiling, for an actionable refusal. */
function networkLayerText(layer: DeviceSandboxLayer | null): string {
  switch (layer) {
    case "platform":
      return "the platform (a super admin)";
    case "org":
      return "the organization (an org admin)";
    case "provider":
      return "its sandbox provider";
    default:
      return "its owner";
  }
}

/** The audit actions a device's recent setting changes list. */
const SETTING_CHANGE_ACTIONS = [
  "device.policy_changed",
  "device.policy_unknown",
  "device.policy_failed",
  "device.owner_ceiling_changed",
  "device.network_changed",
] as const;

/** One side of an audited ceiling change; null when the row does not carry a readable one. */
function ceilingFactsOf(v: unknown): DeviceCeilingFacts | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  // rows written before the rename carry the same fact as `fullAccess`
  const outside = typeof o.outsideSandbox === "boolean" ? o.outsideSandbox : o.fullAccess;
  if (typeof outside !== "boolean") return null;
  const reach = o.restrictedProjectReach;
  return {
    outsideSandbox: outside,
    ...((reach === "workspace" || reach === "os-user") && { restrictedProjectReach: reach }),
    ...((o.network === "open" || o.network === "allowlist") && { network: o.network }),
  };
}

/** One side of an audited cloud network change. */
function networkSettingOf(v: unknown): DeviceNetworkSetting {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const mode = o.mode;
  return {
    mode: mode === "open" || mode === "allowlist" || mode === "none" ? mode : null,
    hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === "string") : [],
  };
}

/** One audit row of {@link SETTING_CHANGE_ACTIONS} as a {@link DeviceSettingChangeView}. */
function settingChangeOf(
  action: string,
  at: Date,
  d: Record<string, unknown>,
  by: string | null,
): DeviceSettingChangeView {
  const hosts = (v: unknown) =>
    Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
  const via: DeviceSettingChangeView["via"] =
    d.via === "im"
      ? "im"
      : d.via === "device"
        ? "device"
        : d.via === "token"
          ? "token"
          : d.via === "agent"
            ? "agent"
            : "web";
  const base = { at: at.toISOString(), add: [], remove: [], ceiling: null, network: null, by, via };
  if (action === "device.owner_ceiling_changed") {
    const to = ceilingFactsOf(d.to);
    return {
      ...base,
      kind: "ceiling",
      ceiling: to === null ? null : { from: ceilingFactsOf(d.from), to },
      outcome: "applied",
    };
  }
  if (action === "device.network_changed")
    return {
      ...base,
      kind: "network",
      network: { from: networkSettingOf(d.from), to: networkSettingOf(d.to) },
      outcome: "applied",
    };
  return {
    ...base,
    kind: "policy",
    add: hosts(d.add),
    remove: hosts(d.remove),
    outcome:
      action === "device.policy_unknown"
        ? "unknown"
        : action === "device.policy_failed"
          ? "failed"
          : "applied",
  };
}

/**
 * The sandbox view of one device: its effective {@link DeviceSandbox} with its own network setting
 * (`own`: a local machine's owner facts, a cloud device's stored choice) and the instance's pending
 * change with the recent changes.
 */
export function sandboxViewOf(
  box: DeviceSandbox,
  own:
    | Pick<OwnerFacts, "state" | "network" | "allowedDomains">
    | { networkMode: "open" | "allowlist" | "none" | null; networkHosts: readonly string[] },
  extra: Pick<DeviceSandboxView, "pendingNextUse" | "pendingFilesReset" | "recent">,
): DeviceSandboxView {
  const local = "state" in own;
  return {
    network: box.networkMode,
    networkCeiling: box.networkCeiling,
    hosts: [...box.hosts],
    ownNetwork: local ? (own.state === "missing" ? null : own.network) : own.networkMode,
    allowedDomains: local ? [...own.allowedDomains] : [...own.networkHosts],
    outsideSandbox: box.outsideSandbox,
    restrictedProjectReach: box.restrictedProjectReach,
    layer: { ...box.layer },
    ...extra,
  };
}

/** The read-only owner ceiling view of a listed local device row. */
function ownerCeilingViewOf(
  r: { source: "cloud" | "local"; machine_id: string | null; machine_owner_report: unknown },
  online: boolean,
): DeviceOwnerCeilingView | null {
  if (r.source === "cloud" || r.machine_id === null) return null;
  const f = ownerFactsOf({ owner_report: r.machine_owner_report });
  return {
    state: f.state,
    revision: f.revision,
    sequence: f.sequence,
    outsideSandbox: f.outsideSandbox,
    network: f.network,
    allowedDomains: [...f.allowedDomains],
    restrictedProjectReach: f.restrictedProjectReach,
    observedAt: f.observedAt,
    stale: !online || f.state !== "report",
  };
}

/** The owner ceiling narrowing the web may send: anything wider is refused, never sent. */
function narrowOnly(c: {
  outsideSandbox?: unknown;
  network?: unknown;
  restrictedProjectReach?: unknown;
}): DeviceOwnerCeilingNarrowing {
  if (
    (c.outsideSandbox !== undefined && c.outsideSandbox !== false) ||
    (c.network !== undefined && c.network !== "allowlist") ||
    (c.restrictedProjectReach !== undefined && c.restrictedProjectReach !== "workspace")
  )
    throw new ApiError(
      "validation_failed",
      "The device page can only narrow a machine's owner ceiling; widen it on the machine with capybara-device ceiling set",
    );
  return {
    ...(c.outsideSandbox === false && { outsideSandbox: false as const }),
    ...(c.network === "allowlist" && { network: "allowlist" as const }),
    ...(c.restrictedProjectReach === "workspace" && {
      restrictedProjectReach: "workspace" as const,
    }),
  };
}
