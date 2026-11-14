import { randomUUID } from "node:crypto";
import type {
  DeviceLocalPolicySummary,
  LocalizedName,
  SandboxLimits,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { DevicePolicyService } from "../local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../local-devices/keys.js";
import { MachinesService } from "../local-devices/machines.js";
import { deviceFeaturesOf, localModeOf, localPolicyOf } from "../local-devices/policy-summary.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import type { DeviceModeLevel } from "../runtime/context/device-paths.js";
import { oweDeviceDestroy, SandboxJobs } from "../sandbox/jobs.js";
import {
  type DeviceNetwork,
  type EffectiveDevicePolicy,
  effectiveDevicePolicy,
  type NetworkKind,
  type OrgDeviceSettings,
  readDeploymentDevicePolicy,
  type SandboxMode,
} from "../sandbox/modes.js";
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
  /** Its mode and network (auto mode spec §4.3). */
  mode: DeviceModeView;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /**
   * The sandbox limits of its effective mode (auto mode spec §4.2): what a cloud instance is
   * created with; for a local device the sandbox-mode allowlist.
   */
  limits: SandboxLimits;
  createdAt: string;
}

/**
 * A device's mode and network as its owner sees it (auto mode spec §4.1–§4.3).
 */
export interface DeviceModeView {
  /**
   * The mode its commands run at: the local device's choice cut to {@link allowedMode}; a cloud
   * device has no choice, so it follows {@link allowedMode}.
   */
  mode: SandboxMode;
  /** `auto` only when the platform's and the org's `autoMode` leave it allowed. */
  allowedMode: SandboxMode;
  /** Which layer allows auto mode (`org`: the org set it; `platform`: the org follows the platform); null when only sandbox mode is allowed. */
  allowedBy: "org" | "platform" | null;
  /** Its network (a cloud device's effective one; a local device's sandbox-mode allowlist). */
  network: { kind: NetworkKind; hosts: string[]; source: "org" | "platform" };
  /** A local device: the mode its machine reported and its own sandbox-mode allowlist; null for cloud. */
  local: { reported: SandboxMode | null; allowedDomains: string[] } | null;
  /**
   * A cloud device's instance runs another mode or network kind: its next use updates or recreates
   * it, files kept (「下次使用时生效，文件保留」).
   */
  pendingNextUse: boolean;
  /**
   * Its provider applies limits at its file system (`limitsApplyAt: "fileSystem"`) and the instance
   * runs another mode or network kind: only a file reset applies it (「重置文件后生效」).
   */
  pendingFilesReset: boolean;
  /** Its last {@link RECENT_POLICY_CHANGES} mode and policy changes, newest first. */
  recent: DeviceModeChangeView[];
}

/** How many recent mode and policy changes a device view lists. */
export const RECENT_POLICY_CHANGES = 10;

/**
 * One mode or policy change of a device, as its owner sees it on the device page:
 * - `policy` (`device.policy_changed`): a local policy change sent to the machine (`web`, `im`), or
 *   made on the machine by its owner (`device`, `capybara-device policy ...`); one sent whose
 *   answer never came (`device.policy_unknown`) or that failed (`device.policy_failed`) too;
 * - `mode` (`device.mode_changed`): the device switched between auto and sandbox mode, on the
 *   machine (`device`) or by a policy op (`web`, `im`).
 */
export interface DeviceModeChangeView {
  at: string;
  kind: "policy" | "mode";
  /** Hosts added to / removed from the local allowlist (`policy` only; else empty). */
  add: string[];
  remove: string[];
  /** The mode change (`from`: the previous mode the machine reported); null when it did not change. */
  mode: { from?: SandboxMode | null; to: SandboxMode } | null;
  /** The deciding account's display name (null when the account is gone). */
  by: string | null;
  /** `device`: made or reported on the machine itself. */
  via: "web" | "im" | "device";
  /**
   * What became of a `policy` change sent to the machine: `applied` (also every change made or
   * reported on the machine, and every mode row); `unknown`, its answer never came, `failed`, the
   * machine refused it, never received it or stopped while applying it.
   */
  outcome: "applied" | "unknown" | "failed";
}

/** A change of a local device's policy by its owner (`POST /devices/:id/policy`). */
export interface DevicePolicyChange {
  add?: string[] | undefined;
  remove?: string[] | undefined;
  /** Switch the sandbox back on; auto mode is turned on only on the machine. */
  mode?: "sandbox" | undefined;
}

/** What `PATCH /devices/:id` changes. */
export interface DevicePatch {
  name?: string;
  /**
   * A narrowing mode change (`sandbox` only): a cloud device stores it and applies the org's
   * `cloudNetwork`; a local device refuses it here (`device.mode_on_device`, its mode is its
   * machine's).
   */
  mode?: "sandbox";
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
   * `PATCH /devices/:id`: renames one of the person's live devices ({@link rename}) and narrows a
   * cloud device to sandbox mode, in one transaction. A local device's mode lives on its machine,
   * so a `mode` for it is refused (`device.mode_on_device`; {@link changePolicy}); auto mode is
   * never set from the web (auto mode spec §4.3). Callers make sure only a person in a session
   * changes a device.
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
    if (patch.mode !== undefined) {
      // A cloud device's switch only narrows (auto → sandbox); a local device's mode lives on its
      // machine (auto mode spec §4.3).
      if (before.source !== "cloud") {
        throw new ApiError(
          "device.mode_on_device",
          "This device's mode is kept on its connected machine: switch to sandbox mode from the device page (sent to the machine) or run capybara-device mode sandbox there.",
        );
      }
      if (before.mode !== "sandbox") {
        // `from` is the mode it ran at before, which may already be sandbox (the org turned it off)
        const effective = await this.sandbox.devicePolicy({ orgId, deviceId: id });
        await this.db
          .updateTable("devices")
          .set({ mode: "sandbox", updated_at: sql<Date>`now()` })
          .where("id", "=", id)
          .execute();
        if (effective.mode !== "sandbox") {
          await audit(this.db.db, {
            actorAccountId: accountId,
            ...(actorTokenId !== undefined && { actorTokenId }),
            orgId,
            action: "device.mode_changed",
            target: id,
            detail: { from: effective.mode, to: "sandbox", by: accountId, via: "web" },
          });
        }
      }
    }
    if (patch.name !== undefined) {
      await this.renameLocked(orgId, accountId, id, before, patch.name, actorTokenId, undefined);
    }
  }

  /**
   * The mode a sandbox call in the device runs at now, for the model (`device_paths`, auto mode
   * spec §4.2): the effective policy for the mode it runs at (a local machine's derived mode,
   * failing closed; a cloud device's narrowing switch, else the allowed mode), its network, and a
   * cloud device's pending file-reset state (the mode and network its instance still runs with).
   * Null when the device is not a live device of the org.
   */
  async modeLevel(orgId: string, deviceId: string): Promise<DeviceModeLevel | null> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.source", "e.mode", "m.features", "m.local_policy"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const [deployment, settings] = await Promise.all([
      readDeploymentDevicePolicy(this.db.db, this.config),
      readOrgSettings(this.db.db, orgId),
    ]);
    // a local device's mode is derived fail-closed; a cloud device's switch only narrows it
    const chosen: SandboxMode | null =
      row.source === "local" ? localModeOf(row.features, row.local_policy) : (row.mode ?? null);
    const policy = effectiveDevicePolicy(deployment, settings, chosen);
    let mode = policy.mode;
    let network: DeviceNetwork =
      row.source === "local"
        ? { kind: "allowlist", hosts: [...policy.localAllowedDomains] }
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
   * The owner changes one of their own devices' local policy (network ask-to-allow spec §7, §13
   * Q6; auto mode spec §4.1): sent to the machine with the `policy` op, which is the authority and
   * answers with the policy as written. Anyone but the owner gets `device.not_found`. The owner may
   * add or remove sandbox-mode hosts, and turn the sandbox back on (`mode: "sandbox"`); auto mode
   * is turned on only on the machine. The machine offline → `device.offline`; a cloud device or a
   * program without the `policyOpId` feature → `device.policy_unsupported`; the machine's refusal →
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
    const out = await this.policies.apply({
      orgId,
      deviceId: id,
      change: {
        ...(change.add !== undefined && { add: change.add }),
        ...(change.remove !== undefined && { remove: change.remove }),
        ...(change.mode !== undefined && { mode: change.mode }),
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
        "e.mode",
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
    const [names, recent, settings, deployment] = await Promise.all([
      this.displayNames.many(demotedProviders),
      this.recentModeChanges(
        orgId,
        rows.map((r) => r.id),
      ),
      readOrgSettings(this.db.db, orgId),
      readDeploymentDevicePolicy(this.db.db, this.config),
    ]);
    const summaryOf = (r: (typeof all)[number]) =>
      r.source === "local" ? localPolicyOf(r.machine_local_policy) : null;
    /** The mode the device chose: its machine's report (local) or its switch (cloud, sandbox only). */
    const chosenOf = (r: (typeof all)[number]): SandboxMode | null =>
      r.source === "local" ? localModeOf(r.machine_features, r.machine_local_policy) : r.mode;
    const policyOf = (r: (typeof all)[number]): EffectiveDevicePolicy =>
      effectiveDevicePolicy(deployment, settings, chosenOf(r));
    // each device's limits and its instance's pending change
    const perDevice = new Map(
      await Promise.all(
        rows.map(async (r) => {
          const policy = policyOf(r);
          const [limits, state] = await Promise.all([
            this.sandbox.deviceLimits({ orgId, deviceId: r.id }, { policy, source: r.source }),
            r.source === "cloud"
              ? this.sandbox.limitsState({ orgId, deviceId: r.id }, { policy })
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
        mode: deviceModeViewOf(
          policyOf(r),
          settings,
          r.source === "local",
          summaryOf(r),
          {
            pendingNextUse: perDevice.get(r.id)?.state.pendingNextUse ?? false,
            pendingFilesReset: perDevice.get(r.id)?.state.pendingFilesReset ?? false,
            recent: recent.get(r.id) ?? [],
          },
          this.config.get().sandbox.limits.egress === "none",
        ),
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
   * The last {@link RECENT_POLICY_CHANGES} mode and policy changes of each device in the org
   * (audit rows `device.policy_changed`, `device.policy_unknown`, `device.policy_failed`,
   * `device.mode_changed`), newest first, with the deciding account's display name.
   */
  private async recentModeChanges(
    orgId: string,
    deviceIds: string[],
  ): Promise<Map<string, DeviceModeChangeView[]>> {
    const out = new Map<string, DeviceModeChangeView[]>();
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
      .where("a.action", "in", [...MODE_CHANGE_ACTIONS])
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
        modeChangeOf(
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
    mode: "sandbox" | null;
  }> {
    await this.lockMember(orgId, accountId);
    const row = await this.db
      .selectFrom("devices")
      .select(["name", "is_default", "source", "mode"])
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
  network: { kind: l.network.kind, hosts: [...l.network.hosts] },
});

/** The audit actions a device's recent mode and policy changes list. */
const MODE_CHANGE_ACTIONS = [
  "device.policy_changed",
  "device.policy_unknown",
  "device.policy_failed",
  "device.mode_changed",
] as const;

const modeOrNull = (v: unknown): SandboxMode | null => (v === "auto" || v === "sandbox" ? v : null);

/** One audit row of {@link MODE_CHANGE_ACTIONS} as a {@link DeviceModeChangeView}. */
function modeChangeOf(
  action: string,
  at: Date,
  d: Record<string, unknown>,
  by: string | null,
): DeviceModeChangeView {
  const hosts = (v: unknown) =>
    Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
  const base = { at: at.toISOString(), add: [], remove: [], mode: null, by };
  if (action === "device.mode_changed") {
    const to = modeOrNull(d.to);
    return {
      ...base,
      kind: "mode",
      mode: to === null ? null : { ...(d.from !== undefined && { from: modeOrNull(d.from) }), to },
      via: d.via === "im" ? "im" : d.via === "device" ? "device" : "web",
      outcome: "applied",
    };
  }
  return {
    ...base,
    kind: "policy",
    add: hosts(d.add),
    remove: hosts(d.remove),
    via: d.via === "im" ? "im" : d.via === "device" ? "device" : "web",
    outcome:
      action === "device.policy_unknown"
        ? "unknown"
        : action === "device.policy_failed"
          ? "failed"
          : "applied",
  };
}

/**
 * The mode view of one device (auto mode spec §4.3): its effective policy with the mode its
 * machine reported (`summary`, local devices only), the network and where it comes from, and the
 * instance's pending change with the recent changes.
 */
export function deviceModeViewOf(
  policy: EffectiveDevicePolicy,
  settings: OrgDeviceSettings,
  local: boolean,
  summary: DeviceLocalPolicySummary | null,
  extra: { pendingNextUse: boolean; pendingFilesReset: boolean; recent: DeviceModeChangeView[] },
  /** The platform kill switch (`sandbox.limits.egress: none`): the network is the platform's. */
  killSwitch = false,
): DeviceModeView {
  const networkKind = local ? "allowlist" : policy.network.kind;
  const org = settings.cloudNetwork;
  // "org" only when the org supplied what is in effect: the kill switch always wins; auto mode
  // ignores the org's network; a local device's list is the org's only when the org gave hosts;
  // a sandbox cloud device's kind is the org's when it matches the mode the org chose
  const source: "org" | "platform" = killSwitch
    ? "platform"
    : local
      ? policy.mode === "sandbox" && org?.allowHosts !== undefined
        ? "org"
        : "platform"
      : policy.mode === "sandbox" &&
          org !== undefined &&
          (org.mode === "open" ? networkKind === "open-public" : networkKind === "allowlist")
        ? "org"
        : "platform";
  const network = local
    ? { kind: "allowlist" as const, hosts: [...policy.localAllowedDomains], source }
    : { kind: policy.network.kind, hosts: [...policy.network.hosts], source };
  return {
    mode: policy.mode,
    allowedMode: policy.allowedMode,
    allowedBy:
      policy.allowedMode === "sandbox"
        ? null
        : settings.autoMode === "allowed"
          ? "org"
          : "platform",
    network,
    local: local
      ? {
          reported: summary?.mode ?? null,
          allowedDomains: [...(summary?.allowedDomains ?? [])],
        }
      : null,
    ...extra,
  };
}
