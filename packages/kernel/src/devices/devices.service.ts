import { randomUUID } from "node:crypto";
import {
  type DeviceReport,
  type LocalizedName,
  type SandboxBrowseScope,
  type SandboxLimits,
  type SandboxOperationScope,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { SandboxOperationIntentsTable } from "../db/kernel-schema.js";
import { DialInHandlers } from "../dial-in/handlers.js";
import { DialInMachines } from "../dial-in/machines.js";
import { DialInRelay } from "../dial-in/relay.js";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { avatarColumns, type PersonRef, personAvatarUrl } from "../identity/account-avatar.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  assertNotSharedAdmission,
  TransactionHost,
  withOrderedLocks,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import type { DeviceModeLevel } from "../runtime/context/device-paths.js";
import { DeviceReports } from "../sandbox/device-reports.js";
import type {
  DeviceSandbox,
  DeviceSandboxLayer,
  HostGrantCeiling,
} from "../sandbox/device-sandbox.js";
import { hostGrantable } from "../sandbox/device-sandbox.js";
import { oweDeviceDestroy, SandboxJobs } from "../sandbox/jobs.js";
import { coversHost, type DeviceLimits, type DeviceNetwork } from "../sandbox/modes.js";
import {
  hostsNarrowed,
  needsOpenNetwork,
  PermissionCeilingWrites,
} from "../sandbox/permission-ceiling-writes.js";
import { ownNetwork, PermissionFacts } from "../sandbox/permission-facts.js";
import { type DeviceProviderEntry, DeviceProviders, servesDialIn } from "../sandbox/providers.js";
import { deviceNotFound, SandboxService } from "../sandbox/sandbox.service.js";
import { DeviceAccess } from "./access.js";
import { DeviceProviderSelection } from "./device-provider-selection.js";

/** A device as its owner sees it (`GET /orgs/:orgId/devices`). */
export interface DeviceView {
  id: string;
  /** null for the default device (shown as the localized "Personal"). */
  name: string | null;
  isDefault: boolean;
  ownerKind: "personal";
  /** The provider it is bound to for life (`devices.provider`). */
  provider: string | null;
  /**
   * Its provider serves its devices over the dial-in channel (a machine signs in to the device);
   * false while the provider is not loaded here.
   */
  dialIn: boolean;
  /** Its provider serves the org now (on in the org). */
  available: boolean;
  /**
   * What its provider last reported about it (`devices.report`, the stored copy: never asked on
   * the request path); null until a first report is stored. Kept while the provider is off.
   */
  report: DeviceReport | null;
  /** A dial-in device: some replica holds its machine's connection now; null for any other. */
  online: boolean | null;
  /** The machine signed in to a dial-in device (its unrevoked one); null for any other or none. */
  machine: DeviceMachineView | null;
  /** Its effective device sandbox, the same under every permission profile. */
  sandbox: DeviceSandboxView;
  /**
   * A device whose B1 snapshot found applied limits it could not establish exactly: nothing runs
   * on it until a file reset establishes them (`device.permission_reconcile_required` at
   * admission).
   */
  reconcileRequired: boolean;
  /** Its file system is gone at the provider; reset the files to use it again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  /** Its sandbox limits: the resources and network its instance is created with. */
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
  /** The device's own network setting, its stored choice (null follows its org). */
  ownNetwork: "open" | "allowlist" | "none" | null;
  /**
   * The device's own host list, which only narrows the org's hosts: its stored hosts (empty: it
   * follows its org's hosts).
   */
  allowedDomains: string[];
  /** Whether a call may be granted escalation outside the sandbox (its provider decides it). */
  outsideSandbox: boolean;
  /** The layer that set each ceiling (a disabled option names it), or null when nothing did. */
  layer: { network: DeviceSandboxLayer | null; outsideSandbox: DeviceSandboxLayer | null };
  /**
   * The device's instance runs another network: its next use updates or recreates it, files kept
   * (the page says it applies on next use).
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

/** How many recent setting changes a device view lists. */
export const RECENT_POLICY_CHANGES = 10;

/**
 * One setting change of a device, as its owner sees it on the device page: its sandbox network
 * changed (`device.network_changed`), whatever its provider.
 */
export interface DeviceSettingChangeView {
  at: string;
  kind: "network";
  network: { from: DeviceNetworkSetting; to: DeviceNetworkSetting };
  /** The deciding account (null when the account is gone). */
  by: PersonRef | null;
  /**
   * Where it was decided: `web` on the device page or a network approval there, `im` a network
   * approval on an IM card, `token` through an API token, `agent` an agent's Platform tool call.
   */
  via: DeviceNetworkChangeVia;
}

/** Where a device's network change was decided ({@link DeviceSettingChangeView.via}). */
export type DeviceNetworkChangeVia = "web" | "im" | "token" | "agent";

/** A device's stored network setting: `mode` null follows its org. */
export interface DeviceNetworkSetting {
  mode: "open" | "allowlist" | "none" | null;
  hosts: string[];
}

/** What `PATCH /devices/:id` changes. */
export interface DevicePatch {
  name?: string;
  /** The device's sandbox network, within its org's and the platform's ceilings. */
  network?: { mode: "open" | "allowlist" | "none" | null; hosts?: string[] | undefined };
}

/** The machine signed in to a dial-in device, as its owner sees it. */
export interface DeviceMachineView {
  id: string;
  name: string;
  os: string;
  programVersion: string | null;
  lastSeenAt: string | null;
}

/** The list response: the person's live devices in the org. */
export interface DeviceList {
  items: DeviceView[];
  /** The person's default device; null when there is none (no default provider to make it). */
  defaultId: string | null;
  /** The device of the person's most recently updated conversation that has a live one. */
  lastUsedId: string | null;
  /** The device providers on in the org now (a new device may name one), in name order. */
  providers: DeviceProviderOption[];
  /**
   * The provider a new device gets when it names none: the org's (else the platform's) default,
   * null when that serves the org no more or none is set (never another provider in its place).
   */
  defaultProvider: string | null;
}

/** A device provider a new device may be created on ({@link DeviceList.providers}). */
export interface DeviceProviderOption {
  plugin: string;
  /** The extension's display name; null when it has none. */
  displayName: LocalizedName | null;
}

const isUniqueViolation = (e: unknown, constraint: string): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "23505" &&
  (e as { constraint?: unknown }).constraint === constraint;

/** The names of `on`, for a refusal's message; a hint when there are none. */
const providerChoices = (on: DeviceProviderEntry[]): string =>
  on.length > 0
    ? on.map((e) => e.plugin).join(", ")
    : "none is on in this organization; ask an org admin to switch one on";

/** A new device names no provider and the org has no default one serving it (400). */
const providerRequired = (on: DeviceProviderEntry[]): ApiError =>
  new ApiError("device.provider_required", `Choose a device provider: ${providerChoices(on)}`);

/**
 * A new device names a provider that does not serve the org (unknown, not loaded, off in the org,
 * or kernel-internal): `validation_failed` at `provider`.
 */
const providerNotOn = (provider: string, on: DeviceProviderEntry[]): ApiError => {
  const message = `Device provider ${provider} is not on in this organization; choose one of: ${providerChoices(on)}`;
  return new ApiError("validation_failed", message, [{ path: "provider", message }]);
};

/** A device sign-in names a provider that is no dial-in provider on in the org (403). */
export const dialInProviderUnavailable = (provider: string): ApiError =>
  new ApiError(
    "device.provider_unavailable",
    `Device provider ${provider} cannot take a machine in this organization; choose one of the providers listed on the sign-in page`,
  );

const nameTaken = (): ApiError =>
  new ApiError("device.name_taken", "You already have a device with this name");

/**
 * Personal devices (spec 2026-11-07-environments-design §4.2 items 7, 12, 13; §6; §9), each
 * bound for life to the device provider it was created on (device-provider spec §6.1) and handled
 * the same way whatever that provider is (a dial-in provider's device is signed in from its
 * machine); a person's devices in an org, visible and usable only by their owner (anyone else gets
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
    @Inject(DeviceProviderSelection)
    private readonly selection: Pick<
      DeviceProviderSelection,
      "onInOrg" | "isOnInOrg" | "defaultFor"
    >,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "devicePolicy" | "deviceLimits" | "limitsState">,
    @Inject(SandboxJobs) private readonly sandboxJobs: Pick<SandboxJobs, "resetFiles">,
    /** Owes a deleted device's destruction in the delete's transaction. */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    /** Whether a dial-in device's machine is connected now. */
    @Inject(DialInRelay) private readonly relay: Pick<DialInRelay, "online">,
    /** Each device's provider (whether it serves its devices over the dial-in channel). */
    @Inject(DeviceProviders) private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Inject(DialInMachines)
    private readonly machines: Pick<DialInMachines, "revokeActive">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Inject(PermissionFacts)
    private readonly facts: Pick<PermissionFacts, "deviceSandbox" | "deviceSandboxFacts">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
    /** Each device's stored provider report (read only; never asks the provider). */
    @Inject(DeviceReports) private readonly reports: Pick<DeviceReports, "read">,
    /** The dial-in providers on in an org (a device signed in from a machine). */
    @Inject(DialInHandlers) private readonly dialIn: Pick<DialInHandlers, "onInOrg">,
  ) {}

  /**
   * The person's live devices in the org, the default first, then by creation, with the device
   * providers on in the org and its default one. With a default provider serving the org the
   * default device is created first if missing (its first need, spec §4.2 item 7; an existing one
   * is only read, whatever its provider's state).
   */
  async list(orgId: string, accountId: string): Promise<DeviceList> {
    const on = await this.selection.onInOrg(orgId);
    const names = await this.displayNames.many(on.map((e) => e.plugin));
    const providers = on.map((e) => ({
      plugin: e.plugin,
      displayName: names.get(e.plugin) ?? null,
    }));
    const defaultProvider = (await this.selection.defaultFor(orgId))?.plugin ?? null;
    const defaultId = await this.ensureDefault(orgId, accountId);
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
      providers,
      defaultProvider,
    };
  }

  /** One of the person's live devices; anyone else's (or a missing one) → `not_found`. */
  async get(orgId: string, accountId: string, id: string): Promise<DeviceView> {
    const [view] = await this.views(orgId, accountId, id);
    if (!view) throw deviceNotFound();
    return view;
  }

  /**
   * A new personal device, ready at once (its instance and files are made on first use),
   * bound for life to `input.provider` or, without one, the org's default provider: a provider not
   * on in the org (unknown, not loaded, off, kernel-internal) → `validation_failed` at `provider`;
   * none named and no default serving the org → `device.provider_required`. A live name of the
   * person's (case-insensitive) → `device.name_taken`; `devices.maxPersonal` live ones (the
   * default counts) → `device.limit_reached`. Serialized per person by their membership row.
   * Nothing is written before every refusal is past.
   */
  async create(
    orgId: string,
    accountId: string,
    input: { name: string; provider?: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<DeviceView> {
    const provider = await this.providerFor(orgId, input.provider);
    const id = await this.insert(orgId, accountId, input.name, provider, actorTokenId, auditDetail);
    return this.get(orgId, accountId, id);
  }

  /**
   * The provider a new device of `orgId` is bound to: `named` when it serves the org now
   * (one of {@link DeviceProviderSelection.onInOrg}), else the org's default
   * ({@link DeviceProviderSelection.defaultFor}) when none is named; never another one.
   */
  private async providerFor(orgId: string, named: string | undefined): Promise<string> {
    const on = await this.selection.onInOrg(orgId);
    if (named !== undefined) {
      if (on.some((e) => e.plugin === named)) return named;
      throw providerNotOn(named, on);
    }
    const fallback = await this.selection.defaultFor(orgId);
    if (!fallback) throw providerRequired(on);
    return fallback.plugin;
  }

  @Transactional()
  private async insert(
    orgId: string,
    accountId: string,
    name: string,
    provider: string,
    actorTokenId: string | undefined,
    auditDetail?: Record<string, unknown>,
  ): Promise<string> {
    return this.insertNamed(orgId, accountId, name, provider, actorTokenId, auditDetail ?? {});
  }

  /**
   * A new personal device for a machine being signed in (the device sign-in; the machine row is
   * the caller's), bound for life to the dial-in provider `provider`: one that serves the org now
   * and declares `permissions.dialIn` ({@link DialInHandlers.onInOrg}), else
   * `device.provider_unavailable`. Joins the caller's transaction (the device authorization's).
   * Counted against `devices.maxPersonal` (`device.limit_reached`); a live name of the
   * person's → `device.name_taken`.
   */
  @Transactional()
  async createDialIn(
    orgId: string,
    accountId: string,
    provider: string,
    name: string,
  ): Promise<{ id: string }> {
    if (!(await this.dialIn.onInOrg(orgId)).some((p) => p.plugin === provider)) {
      throw dialInProviderUnavailable(provider);
    }
    const id = await this.insertNamed(orgId, accountId, name, provider, undefined, {});
    return { id };
  }

  /**
   * Inserts a named personal device under the person's membership lock, after the limit
   * and name checks, and audits `device.created` (with its provider). Runs in the caller's
   * transaction.
   */
  private async insertNamed(
    orgId: string,
    accountId: string,
    name: string,
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
      detail: { name, provider, ...auditDetail },
    });
    return id;
  }

  /**
   * The refusals {@link create} would raise, read without locks or writes (a precheck before a
   * confirmation card): the provider (named and not on in the org, or none and no default), the
   * person's limit, a name already taken. Throws the same {@link ApiError}s; a race still ends in
   * `create`'s own refusal.
   */
  async checkCreate(
    orgId: string,
    accountId: string,
    name: string,
    provider?: string,
  ): Promise<void> {
    await this.providerFor(orgId, provider);
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
   * The refusals {@link resetFiles} would raise (not found, its provider not on, a provider that
   * offers no reset), read only.
   */
  async checkReset(orgId: string, accountId: string, id: string): Promise<void> {
    await this.access.usable(orgId, accountId, id);
    refuseDeviceReset(await this.reports.read(orgId, id));
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
   * `PATCH /devices/:id`: renames one of the person's live devices ({@link rename}) and sets its
   * sandbox network ({@link networkLocked}), in one transaction, the same for every provider. A
   * network change takes the membership, the device row and the device's permission write lock as
   * the ordered prelude (`withOrderedLocks`): inside a run's fence (`devices.set-network`) they
   * follow the org row and precede the conversation rows. `narrowOnly` (an API token, the Platform
   * tool): the network may only narrow, stored and effective.
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
      await this.networkLocked(orgId, accountId, id, patch.network, actorTokenId, opts);
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
   * Checks a network change without writing anything and without locks (the Platform tool's
   * precheck): the device is the person's live device, and the change stays within
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
      .select(["id"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw deviceNotFound();
    await this.planNetwork(orgId, id, network, narrowOnly);
  }

  /**
   * Decides a network change (read only): the stored setting before and after, the effective
   * device sandbox before and after (computed in memory from the patched setting), and whether it
   * widens. Refuses, without writing: the open network above the ceilings or a host outside the
   * org's list (`device.network_not_allowed`), and with `narrowOnly` a widening of the stored
   * setting or of the effective network (`device.network_not_allowed`). Null when nothing changes.
   */
  private async planNetwork(
    orgId: string,
    id: string,
    want: NonNullable<DevicePatch["network"]>,
    narrowOnly: boolean,
  ) {
    const row = await this.db
      .selectFrom("devices")
      .select(["network_mode", "network_hosts"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const own = ownNetwork(row);
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
   * A device's sandbox network (approval-only profiles design, "Settings model"), under the
   * device authority writer held since the prelude: its owner chooses `open`, `allowlist` (its
   * org's hosts, narrowed by its own list: a device list never adds a host; an empty one follows
   * the org's hosts), `none` (closed) or null (follow the org), in both directions within the
   * org's and the platform's ceilings ({@link planNetwork}). The write and its publication are one
   * transaction: a narrowing bumps the device epoch and revokes the admitted or started work it
   * takes ({@link networkNarrowingRevokes}; the revocations are owed through the outbox) and keeps
   * Full consent; a widening resets Full consent with a `permission_profile_changed` event.
   * Audited `device.network_changed` (`via`: `opts.via` (a network approval's), else `web`,
   * `token` for an API token, or the agent's in `auditDetail`).
   */
  private async networkLocked(
    orgId: string,
    accountId: string,
    id: string,
    want: NonNullable<DevicePatch["network"]>,
    actorTokenId: string | undefined,
    opts: {
      narrowOnly?: boolean;
      auditDetail?: Record<string, unknown>;
      via?: DeviceNetworkChangeVia;
    },
  ): Promise<void> {
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
    const plan = await this.planNetwork(orgId, id, want, opts.narrowOnly === true);
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
        via: opts.via ?? (actorTokenId !== undefined ? "token" : "web"),
        ...opts.auditDetail,
      },
    });
  }

  /**
   * Adds `hosts` to one of the person's devices' own network list: a network approval decided
   * "add to this device's list" (`via`: where it was decided). It joins the caller's transaction
   * (the approval decision's), with the membership, the device row and the device's permission
   * write lock as the ordered prelude ({@link withOrderedLocks}: inline in a caller's
   * transaction, whose lock order the caller owns), and takes no distributed lock. The write is a
   * network change like `PATCH` ({@link networkLocked}: audited `device.network_changed` from → to,
   * listed as a recent change, the device epoch bumped and the instance marked for its next use).
   * Refuses with `device.network_not_allowed`, writing nothing, unless the stored network is
   * `allowlist` with a host list of its own (a device following its org's hosts already allows
   * every host its list could name) and every host may join that list
   * (`deviceListAddRefusal`). Hosts already listed change nothing.
   */
  async addNetworkHostsIn(
    orgId: string,
    accountId: string,
    deviceId: string,
    hosts: string[],
    via: "web" | "im",
  ): Promise<void> {
    await withOrderedLocks(
      () => this.lockNetworkSubject(orgId, accountId, deviceId),
      () => this.addNetworkHostsLocked(orgId, accountId, deviceId, hosts, via),
    );
  }

  /** {@link addNetworkHostsIn} under the locks of its prelude (naming them again re-checks). */
  @Transactional()
  private async addNetworkHostsLocked(
    orgId: string,
    accountId: string,
    id: string,
    hosts: string[],
    via: "web" | "im",
  ): Promise<void> {
    await this.lockOwn(orgId, accountId, id);
    await this.ceilings.lock({ orgId, deviceId: id }, "device");
    const row = await this.db
      .selectFrom("devices")
      .select(["network_mode", "network_hosts"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const own = ownNetwork(row);
    if (own.networkMode === "none")
      throw new ApiError(
        "device.network_not_allowed",
        "Network access is turned off for this device's sandbox; its owner changes that on the device page",
      );
    if (own.networkMode !== "allowlist" || own.networkHosts.length === 0)
      throw new ApiError(
        "device.network_not_allowed",
        "This device has no host list of its own: it follows its organization's hosts, which already include every host its list could name; an organization admin adds another host to the organization's device network list",
      );
    const wanted = [...new Set(hosts.map((h) => h.toLowerCase()))];
    for (const host of wanted) {
      const invalid = validateAllowHost(host);
      if (invalid.length > 0)
        throw new ApiError("validation_failed", `${host}: ${invalid.join("; ")}`, [
          { path: "hosts", message: `${host}: ${invalid.join("; ")}` },
        ]);
    }
    const facts = await this.facts.deviceSandboxFacts(orgId, id);
    for (const host of wanted) {
      const why = facts.listAddRefusal(host);
      if (why !== null)
        throw new ApiError(
          "device.network_not_allowed",
          `${host} cannot be added to this device's network list: ${why}`,
        );
    }
    await this.networkLocked(
      orgId,
      accountId,
      id,
      { mode: "allowlist", hosts: [...own.networkHosts, ...wanted] },
      undefined,
      { via },
    );
  }

  /**
   * The level a sandbox call in the device runs at now, for the model (legacy `device_paths`, auto
   * mode spec §4.2), the same for every provider: the kernel-internal tier (`SandboxMode`) with
   * its device sandbox network, a pending file-reset state (the tier and network its instance
   * still runs with), and whether its provider runs each operation on its host machine (an
   * operation boundary). Null when the device is not a live device of the org.
   */
  async modeLevel(orgId: string, deviceId: string): Promise<DeviceModeLevel | null> {
    const row = await this.db
      .selectFrom("devices")
      .select(["id"])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const policy = await this.sandbox.devicePolicy({ orgId, deviceId });
    let mode = policy.mode;
    let network: DeviceNetwork = policy.network;
    const state = await this.sandbox.limitsState({ orgId, deviceId }, { policy });
    if (state.pendingFilesReset) {
      // an unknown record (an instance made before auto mode) may be wider than the effective
      // limits: tell the model the widest, never a narrower network than it may reach
      mode = state.applied === null ? "auto" : state.applied.mode;
      network = state.applied === null ? { kind: "open-public", hosts: [] } : state.applied.network;
    }
    const box = await this.facts.deviceSandbox(orgId, deviceId);
    return {
      mode,
      allowedMode: policy.allowedMode,
      network,
      local: box.boundary === "operation",
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
   * Deletes one of the person's live devices: soft delete, its IM default row cleared, and a
   * `sandbox-destroy-for` job owed in the same transaction (`device-destroy-<deviceId>`; the
   * worker waits for running commands, then destroys the instance and the files). Conversations bound to it keep pointing at it; their
   * sandbox tools then fail with `device.not_found`. A dial-in device's machine is
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
   * Starts one of the person's devices over with empty files (after
   * `device.files_lost`): records the request (audit), then, after the commit, enqueues the
   * `sandbox-reset-files` job (deterministic id per device), whose worker waits for running
   * commands and destroys any instance and the file system; the next use creates new ones. Its
   * provider must be on (`device.unavailable`) and offer a reset (its report's `reset`, else
   * `device.files_on_device`). An enqueue failure is thrown
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
    refuseDeviceReset(await this.reports.read(orgId, id));
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
   * The person's default device in the org: the live one if any, whatever its provider's state
   * (a default whose provider is off stays the default, unavailable, never demoted or replaced),
   * else a new default (named by the UI, `name` NULL) bound to the org's default provider
   * ({@link DeviceProviderSelection.defaultFor}), else null (no default provider on in the org).
   * An existing one is read without locking.
   *
   * Creating one first takes the person's membership row (`FOR SHARE`, after the org row), so an
   * offboarding that removes them cannot leave a live default behind; not a member (any more) →
   * `org.not_found`. Idempotent under concurrency: the partial unique index on the live default
   * makes a racing insert do nothing, and the select that follows reads the winner. It is the
   * person's baseline, so it is created even at `devices.maxPersonal`.
   */
  async ensureDefault(orgId: string, accountId: string): Promise<string | null> {
    const live = await this.defaultOf(orgId, accountId);
    if (live) return live.id;
    const provider = await this.selection.defaultFor(orgId);
    if (!provider) return null;
    return this.insertDefault(orgId, accountId, provider.plugin);
  }

  @Transactional()
  private async insertDefault(orgId: string, accountId: string, provider: string): Promise<string> {
    await this.lockMember(orgId, accountId, "share");
    const live = await this.defaultOf(orgId, accountId);
    if (live) return live.id;
    await this.db
      .insertInto("devices")
      .values({
        id: randomUUID(),
        org_id: orgId,
        owner_kind: "personal",
        owner_account_id: accountId,
        name: null,
        is_default: true,
        provider,
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

  /** The person's live default device in the org, if any. */
  private async defaultOf(orgId: string, accountId: string): Promise<{ id: string } | undefined> {
    return await this.db
      .selectFrom("devices")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("is_default", "=", true)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  /** The person's live devices (or the one `id`) as views. */
  private async views(orgId: string, accountId: string, id?: string): Promise<DeviceView[]> {
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
        "e.provider",
        "e.network_mode",
        "e.network_hosts",
        "e.permission_reconcile_required",
        "e.created_at",
        "m.id as machine_id",
        "m.name as machine_name",
        "m.os as machine_os",
        "m.program_version as machine_program_version",
        "m.last_seen_at as machine_last_seen_at",
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
    const recent = await this.recentChanges(
      orgId,
      rows.map((r) => r.id),
    );
    // whether each provider serves the org now, evaluated once per provider and request
    const providerNames = [...new Set(rows.flatMap((r) => (r.provider ? [r.provider] : [])))];
    const on = new Map(
      await Promise.all(
        providerNames.map(async (p) => [p, await this.selection.isOnInOrg(orgId, p)] as const),
      ),
    );
    // each device's sandbox, limits, its instance's pending change and its stored report
    const perDevice = new Map(
      await Promise.all(
        rows.map(async (r) => {
          const policy = await this.sandbox.devicePolicy({ orgId, deviceId: r.id });
          const [limits, state, facts, report] = await Promise.all([
            this.sandbox.deviceLimits({ orgId, deviceId: r.id }, { policy }),
            this.sandbox.limitsState({ orgId, deviceId: r.id }, { policy }),
            this.facts.deviceSandboxFacts(orgId, r.id),
            this.reports.read(orgId, r.id),
          ]);
          return [r.id, { limits, state, box: facts.box, report }] as const;
        }),
      ),
    );
    // a dial-in device is online while a replica holds its machine's connection
    const dialIn = new Set(rows.filter((r) => this.isDialIn(r.provider)).map((r) => r.id));
    const online = new Map(
      await Promise.all(
        [...dialIn].map(async (deviceId) => [deviceId, await this.relay.online(deviceId)] as const),
      ),
    );
    return rows.map((r) => {
      const provider = r.provider;
      const live = (r.status === "running" || r.status === "suspended") && r.last_used_at;
      const device = perDevice.get(r.id);
      return {
        id: r.id,
        name: r.name,
        isDefault: r.is_default,
        ownerKind: "personal",
        provider,
        dialIn: dialIn.has(r.id),
        // an instance row of another provider (never written by this kernel) is refused on use
        available:
          provider !== null &&
          (on.get(provider) ?? false) &&
          (r.instance_provider === null || r.instance_provider === provider),
        report: device?.report ?? null,
        online: dialIn.has(r.id) ? (online.get(r.id) ?? false) : null,
        machine:
          dialIn.has(r.id) &&
          r.machine_id !== null &&
          r.machine_name !== null &&
          r.machine_os !== null
            ? {
                id: r.machine_id,
                name: r.machine_name,
                os: r.machine_os,
                programVersion: r.machine_program_version,
                lastSeenAt: r.machine_last_seen_at?.toISOString() ?? null,
              }
            : null,
        sandbox: sandboxViewOf(device?.box as DeviceSandbox, ownNetwork(r), {
          pendingNextUse: device?.state.pendingNextUse ?? false,
          pendingFilesReset: device?.state.pendingFilesReset ?? false,
          recent: recent.get(r.id) ?? [],
        }),
        reconcileRequired: r.permission_reconcile_required,
        filesLost: r.fs_status === "lost",
        instance: live
          ? {
              status: r.status as "running" | "suspended",
              lastUsedAt: (r.last_used_at as Date).toISOString(),
            }
          : null,
        limits: limitsView(device?.limits as DeviceLimits),
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /** Whether `provider` (a device's `devices.provider`) serves its devices over dial-in. */
  private isDialIn(provider: string | null): boolean {
    const p = this.providers.forDevice(provider);
    return p !== undefined && servesDialIn(p);
  }

  /**
   * The last {@link RECENT_POLICY_CHANGES} setting changes of each device in the org (its
   * `device.network_changed` audit rows), newest first, with the deciding account's display name.
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
        "a.at",
        "a.detail",
        "a.actor_account_id",
        sql<number>`row_number() OVER (PARTITION BY a.target ORDER BY a.at DESC, a.id DESC)`.as(
          "n",
        ),
      ])
      .where("a.org_id", "=", orgId)
      .where("a.action", "=", "device.network_changed")
      .where("a.target", "in", deviceIds);
    const rows = await this.db
      .selectFrom(ranked.as("r"))
      .leftJoin("accounts as ac", "ac.id", "r.actor_account_id")
      .select((eb) => [
        "r.target",
        "r.at",
        "r.detail",
        "r.actor_account_id",
        "ac.display_name",
        ...avatarColumns(eb, "ac", "actor"),
      ])
      .where("r.n", "<=", RECENT_POLICY_CHANGES)
      .orderBy("r.at", "desc")
      .execute();
    for (const r of rows) {
      if (r.target === null) continue;
      const list = out.get(r.target) ?? [];
      list.push(
        settingChangeOf(
          r.at,
          (r.detail ?? {}) as Record<string, unknown>,
          r.actor_account_id === null || r.display_name === null
            ? null
            : {
                id: r.actor_account_id,
                name: r.display_name,
                avatarUrl: personAvatarUrl(r, "actor", r.actor_account_id),
              },
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
  }> {
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
 * A device whose provider last reported no file reset (`report.reset` false, device-provider spec
 * §6.1): its files are kept where the provider keeps them and the platform never wipes them
 * (`device.files_on_device`, with the provider's own description). A device with no stored report
 * yet is not refused: its provider's reset decides.
 */
function refuseDeviceReset(report: DeviceReport | null): void {
  if (report !== null && !report.reset) {
    throw new ApiError(
      "device.files_on_device",
      `This device's provider does not reset its files from here (${report.description.en}).`,
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
 * Whether a device's stored network setting widens from `a` to `b`, whatever the network in
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
 * What a device's new network takes from admitted or started work (`next`: its sandbox
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

/** One side of an audited network change. */
function networkSettingOf(v: unknown): DeviceNetworkSetting {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const mode = o.mode;
  return {
    mode: mode === "open" || mode === "allowlist" || mode === "none" ? mode : null,
    hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === "string") : [],
  };
}

/** One `device.network_changed` audit row as a {@link DeviceSettingChangeView}. */
function settingChangeOf(
  at: Date,
  d: Record<string, unknown>,
  by: PersonRef | null,
): DeviceSettingChangeView {
  const via: DeviceNetworkChangeVia =
    d.via === "im" || d.via === "token" || d.via === "agent" ? d.via : "web";
  return {
    at: at.toISOString(),
    kind: "network",
    network: { from: networkSettingOf(d.from), to: networkSettingOf(d.to) },
    by,
    via,
  };
}

/**
 * The sandbox view of one device: its effective {@link DeviceSandbox} with its own stored network
 * setting (`own`) and the instance's pending change with the recent changes.
 */
export function sandboxViewOf(
  box: DeviceSandbox,
  own: { networkMode: "open" | "allowlist" | "none" | null; networkHosts: readonly string[] },
  extra: Pick<DeviceSandboxView, "pendingNextUse" | "pendingFilesReset" | "recent">,
): DeviceSandboxView {
  return {
    network: box.networkMode,
    networkCeiling: box.networkCeiling,
    hosts: [...box.hosts],
    ownNetwork: own.networkMode,
    allowedDomains: [...own.networkHosts],
    outsideSandbox: box.outsideSandbox,
    layer: { ...box.layer },
    ...extra,
  };
}
