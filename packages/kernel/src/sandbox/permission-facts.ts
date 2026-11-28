import { createHash } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type PermissionProfile,
  rootsOf,
  type SandboxHandle,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { permissionCodePointCompare } from "../conversations/events.js";
import type { PermissionRoot } from "../conversations/permission-profile-store.js";
import { DeviceAccess } from "../devices/access.js";
import { deviceNotFound, projectsUnsupported } from "../devices/errors.js";
import { type DeviceProjectScope, projectNotFound, tooBroad } from "../devices/project-rules.js";
import { aboveHome, type WorkingProject } from "../devices/working-root.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { storedReport, storedSupport } from "./device-reports.js";
import {
  type ConsentReach,
  canonicalHostCeiling,
  type DeviceSandbox,
  type DeviceSandboxDeviceLayer,
  deviceListAddRefusal,
  effectiveDeviceSandbox,
  type HostGrantCeiling,
  hostGrantCeiling,
  hostGrantRefusal,
  orgHostsOf,
  providerLayerOf,
  reachWithin,
} from "./device-sandbox.js";
import { readDeviceSandboxSettings } from "./device-sandbox-settings.js";
import {
  appliedOf,
  appliedWider,
  cloudChosenMode,
  coversHost,
  type DeviceNetwork,
  type EffectiveDevicePolicy,
  effectiveDevicePolicy,
  readDeploymentDevicePolicy,
  readInstanceLimits,
} from "./modes.js";
import { assertAuthorityHeld } from "./permission-authority-lock.js";
import {
  deviceWorkAvailability,
  type PermissionAvailability,
  permissionAvailabilityFor,
} from "./permission-availability.js";
import type { AppliedEnvironment, AppliedOuterNetwork } from "./permission-context-types.js";
import { readCurrentReport } from "./permission-runtime-reports.js";
import { DeviceProviders } from "./providers.js";
import { homeOf } from "./review/rules.js";

type Scope = DeviceProjectScope;
/**
 * What decides the working root of a call (project root spec §4.3), read the same way for a
 * sandbox tool and for the command review, so both decide the same root.
 */
export interface WorkingFacts {
  /**
   * The device's workspace: the held instance's committed roots, else the latest `device_paths`
   * roots recorded in the calling conversation, else the root's, else the default.
   */
  workspace: string;
  /** The owner's home: the provider's reported home, else the workspace's home prefix; null: unknown. */
  home: string | null;
  /** The root conversation's latest project snapshot; null: free, or none recorded yet. */
  project: WorkingProject | null;
}

export const permissionScopeHash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const notice =
  "Changes apply to new operations. Work already started keeps its starting permissions.";
/** Database and registered metadata reads only; never provisions or probes a device. */
@Injectable()
export class PermissionFacts {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(DeviceProviders)
    private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Inject(DeviceAccess) private readonly devices: Pick<DeviceAccess, "usable">,
  ) {}
  /**
   * Current policy and the device sandbox; access is checked by the caller. `sandbox` is the device
   * sandbox under the device's current runtime report (else the support stored with its report,
   * else the provider layer assumed before one is recorded), the same under every permission
   * profile.
   */
  async readDevice(orgId: string, deviceId: string) {
    const [policy, availability] = await Promise.all([
      this.devicePolicy({ orgId, deviceId }),
      this.availability(orgId, deviceId),
    ]);
    const sandbox = await this.deviceSandboxFacts(orgId, deviceId, availability);
    return {
      policy,
      sandbox: sandbox.box,
      hostCeiling: sandbox.hostCeiling,
      hostRefusal: sandbox.refusal,
      /** The provider's description of the device (its stored report, English), or null. */
      description: sandbox.description,
      /** How to change the device's limits, in its provider's words (stored report, English). */
      changeHint: sandbox.changeHint,
    };
  }

  /**
   * The effective device sandbox (approval-only profiles design, "Settings model"): the platform,
   * org, device and provider layers read live and combined by {@link effectiveDeviceSandbox}, one
   * path for every provider. The device layer is its stored network choice; the provider layer
   * its current runtime report, else the support stored with its device report (device-provider
   * spec §6.7), else the layer assumed before any ({@link providerLayerOf}).
   */
  async deviceSandbox(
    orgId: string,
    deviceId: string,
    availability?: PermissionAvailability,
  ): Promise<DeviceSandbox> {
    return (await this.deviceSandboxFacts(orgId, deviceId, availability)).box;
  }

  /**
   * {@link deviceSandbox} with the layers a per-call host grant is checked against: its ceiling
   * ({@link hostGrantCeiling}), why a host is unavailable ({@link hostGrantRefusal}) and the
   * crossing ceilings a Full access consent covers ({@link ConsentReach}).
   */
  async deviceSandboxFacts(
    orgId: string,
    deviceId: string,
    availability?: PermissionAvailability,
    /** The device's network as it would be stored (a change checked before it is written). */
    pending?: { networkMode: "open" | "allowlist" | "none" | null; networkHosts: string[] },
    /**
     * Which provider layer: `ceilings` (the support chain, {@link providerLayerOf}; the consent
     * reach reads it too) or `lifecycle` (no support: the network an instance is created with is
     * the device's own choice within the ceilings, never a support read after an earlier
     * instance, so a support arriving never makes the next use recreate the instance; the
     * provider enforces what it can).
     */
    layer: "ceilings" | "lifecycle" = "ceilings",
  ) {
    const [settings, org, row] = await Promise.all([
      readDeviceSandboxSettings(this.db.db, this.config),
      readOrgSettings(this.db.db, orgId),
      this.db
        .selectFrom("devices")
        .select(["network_mode", "network_hosts", "report", "provider"])
        .where("id", "=", deviceId)
        .where("org_id", "=", orgId)
        .executeTakeFirst(),
    ]);
    const limits = this.config.get().sandbox.limits;
    const device: DeviceSandboxDeviceLayer = pending ?? ownNetwork(row);
    const current = availability ?? (await this.availability(orgId, deviceId));
    // the provider's support: its current runtime report, else the one stored with its report
    const support =
      layer === "lifecycle"
        ? null
        : current.state === "supported"
          ? current.report
          : storedSupport(row?.report);
    const platform = {
      settings,
      allowHosts: limits.allowHosts,
      orgHosts: limits.orgHosts,
      egress: limits.egress,
    };
    const orgLayer = {
      ...(org.outsideSandbox !== undefined && { outsideSandbox: org.outsideSandbox }),
      ...(org.deviceNetwork !== undefined && { deviceNetwork: org.deviceNetwork }),
    };
    const box = effectiveDeviceSandbox(platform, orgLayer, device, providerLayerOf(support));
    const report = storedReport(row?.report);
    const hostCeiling = hostGrantCeiling(box, platform, orgLayer);
    return {
      box,
      /** The provider's support the box was computed with (null: none known yet, or `lifecycle`). */
      support,
      hostCeiling,
      /** The org's effective hosts: what a device's own host list may narrow, never add to. */
      orgHosts: orgHostsOf(platform, orgLayer),
      refusal: (host: string) => hostGrantRefusal(host, box, platform, orgLayer),
      /** Why a host cannot be added to the device's own network list ({@link deviceListAddRefusal}). */
      listAddRefusal: (host: string) => deviceListAddRefusal(host, box, platform, orgLayer),
      description: report?.description.en ?? null,
      /** How to change the device's limits, in its provider's words (English), or null. */
      changeHint: report?.changeHint?.en ?? null,
      /**
       * The device's network is an allowlist with a host list of its own: only then can a host
       * join that list (`DevicesService.addNetworkHostsIn`); a device following its org's hosts
       * already allows every host its list could name.
       */
      ownList: device.networkMode === "allowlist" && device.networkHosts.length > 0,
      /** The device's own host list (empty unless its network is an allowlist of its own). */
      ownHosts: device.networkMode === "allowlist" ? [...device.networkHosts] : [],
      /** Where its provider applies new limits (`limitsApplyAt`; absent: at its instance). */
      limitsApplyAt: row ? this.providers.forDevice(row.provider)?.impl.limitsApplyAt : undefined,
      reach: {
        outsideSandbox: box.outsideSandbox,
        networkCeiling: box.networkCeiling,
        networkMode: box.networkMode,
        hostCeiling: canonicalHostCeiling(hostCeiling),
      } satisfies ConsentReach,
    };
  }

  /**
   * The per-call host ceiling of an org, with no device (`hostGrantCeiling` under the platform and
   * org layers alone): what a standing grant that may reach any of the org's devices (a scheduled
   * task's network grant, a network approval) is checked against. A device's own layers only
   * narrow it further.
   */
  async orgHostGrantCeiling(orgId: string): Promise<HostGrantCeiling> {
    const [settings, org] = await Promise.all([
      readDeviceSandboxSettings(this.db.db, this.config),
      readOrgSettings(this.db.db, orgId),
    ]);
    const limits = this.config.get().sandbox.limits;
    const platform = {
      settings,
      allowHosts: limits.allowHosts,
      orgHosts: limits.orgHosts,
      egress: limits.egress,
    };
    const orgLayer = {
      ...(org.outsideSandbox !== undefined && { outsideSandbox: org.outsideSandbox }),
      ...(org.deviceNetwork !== undefined && { deviceNetwork: org.deviceNetwork }),
    };
    const box = effectiveDeviceSandbox(
      platform,
      orgLayer,
      { networkMode: null, networkHosts: [] },
      {
        boundary: "operation",
        network: { openPublic: true, allowlist: true, perOperationHosts: true },
        outsideSandbox: false,
      },
    );
    return hostGrantCeiling(box, platform, orgLayer);
  }

  /** Stored binding only; projectScope supplies the live owner and deletion checks. */
  async readProject(orgId: string, deviceId: string, name: string) {
    return (
      (await this.db
        .selectFrom("device_projects as p")
        .innerJoin("devices as d", "d.id", "p.device_id")
        .select(["p.name", "p.path"])
        .where("d.org_id", "=", orgId)
        .where("p.device_id", "=", deviceId)
        .where("p.name", "=", name)
        .executeTakeFirst()) ?? null
    );
  }
  /**
   * The device's lifecycle policy: the kernel-internal mode tier (`auto` / `sandbox`, recorded with
   * an instance's applied limits) and the network an instance is created with: its device sandbox
   * network ({@link deviceSandbox}), the same for every provider. The B1 snapshot's
   * `outer_network` is no longer read: migrations 0165 and 0167 and the snapshot writer copy an
   * allowlist snapshot into the device's own network choice (`network_mode`, `network_hosts`).
   */
  async devicePolicy(device: { orgId: string; deviceId?: string }): Promise<EffectiveDevicePolicy> {
    const [deployment, settings, chosen] = await Promise.all([
      readDeploymentDevicePolicy(this.db.db, this.config),
      readOrgSettings(this.db.db, device.orgId),
      device.deviceId === undefined
        ? { found: false, mode: null }
        : this.chosenMode(device.orgId, device.deviceId),
    ]);
    const policy = effectiveDevicePolicy(deployment, settings, chosen.mode);
    if (!chosen.found || device.deviceId === undefined) return policy;
    // an instance's outer network is its sandbox network (its provider enforces it), from the
    // device's own choice within the ceilings: the same before and after a support is known
    const box = (
      await this.deviceSandboxFacts(
        device.orgId,
        device.deviceId,
        { state: "unprobed", reason: "lifecycle" },
        undefined,
        "lifecycle",
      )
    ).box;
    return { ...policy, network: networkOfSandbox(box) };
  }

  /**
   * Refuses admission on a cloud device whose B1 snapshot found applied limits it could not
   * establish exactly (unknown, stale, wider or pending a reset): only a lifecycle action that
   * establishes them clears the marker (`CloudPermissionSnapshots.reconcile`). Read under the
   * caller's device authority lock, which the snapshot writer takes for writing.
   */
  async assertCloudReconciled(orgId: string, deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("devices")
      .select("permission_reconcile_required")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (row?.permission_reconcile_required)
      throw new ApiError(
        "device.permission_reconcile_required",
        "This device's sandbox limits must be established again before it runs anything; reset the device's files to apply them",
      );
  }

  /**
   * The mode tier a device chose: the narrower of its old switch and its B1 owner snapshot
   * (`cloudChosenMode`), or null for a device that follows the platform and the org; `found`:
   * a live device of the org. The tier is kernel-internal (instance limits); whether a call may
   * run outside the sandbox is the device sandbox's.
   */
  private async chosenMode(
    orgId: string,
    deviceId: string,
  ): Promise<{ found: boolean; mode: EffectiveDevicePolicy["mode"] | null }> {
    const row = await this.db
      .selectFrom("devices")
      .select(["mode", "owner_full_access"])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row === undefined
      ? { found: false, mode: null }
      : { found: true, mode: cloudChosenMode(row) };
  }

  /**
   * The device's current permission availability: the provider's capability shape, then the
   * runtime report recorded for its current identity under the provider's version, the same for
   * every provider. No probe or provider call.
   */
  private async availability(orgId: string, deviceId: string): Promise<PermissionAvailability> {
    const device = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const provider = device ? this.providers.forDevice(device.provider) : undefined;
    let availability = permissionAvailabilityFor(provider);
    if (availability.state === "unprobed" && provider) {
      availability = (
        await readCurrentReport(this.db.db, deviceId, provider.plugin, provider.version)
      ).availability;
      // a recorded runtime report that cannot enforce the sandbox is the runtime's cause
      if (availability.state === "unsupported")
        availability = { ...availability, cause: { kind: "runtime" } };
    }
    return availability;
  }

  async readWorkingFacts({
    orgId,
    rootConversationId,
    holderConversationId: conversationId,
    deviceId,
  }: {
    orgId: string;
    rootConversationId: string;
    holderConversationId: string;
    deviceId: string;
  }): Promise<WorkingFacts> {
    const [applied, recorded, recordedRoot, reported, project] = await Promise.all([
      this.readAppliedEnvironment({ orgId, deviceId }),
      this.recordedWorkspace(conversationId),
      conversationId === rootConversationId ? null : this.recordedWorkspace(rootConversationId),
      this.reportedHome(orgId, deviceId),
      this.workingProject(orgId, rootConversationId),
    ]);
    // the held instance's committed roots first: a recorded `device_paths` may be stale (an
    // earlier instance's), and the managed writer records the device paths from these roots; the
    // records only stand in while no instance is committed
    const workspace =
      applied?.roots.workspace ?? recorded ?? recordedRoot ?? DEFAULT_SANDBOX_ROOTS.workspace;
    // never from a project root: the provider's reported home, else the workspace's home prefix
    const home = reported?.startsWith("/") ? reported : homeOf(workspace);
    return { workspace, home, project };
  }

  /**
   * The project snapshot that decides the working root of the conversation tree rooted at
   * `rootConversationId` (project root spec §4.3): its latest `project_root` event, read only when
   * the conversation is bound to a project (a free conversation reads one row by its key). Null:
   * free. A bound conversation with no snapshot recorded yet (its first run start could not ask
   * the device: offline, or the read hit its time limit) works in the bound root: the binding was
   * checked when the conversation was created and never changes, and `workingRootOf` still
   * applies the mode, reach and home rules. Only a recorded `unavailable` snapshot (or one
   * without a root) leaves the project for free mode (spec §4.3).
   */
  async workingProject(orgId: string, rootConversationId: string): Promise<WorkingProject | null> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("project_path")
      .where("id", "=", rootConversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (conv?.project_path == null) return null;
    const row = await this.db
      .selectFrom("conversation_events")
      .select([
        sql<string | null>`payload->>'root'`.as("root"),
        sql<boolean>`payload ? 'unavailable'`.as("unavailable"),
      ])
      .where("conversation_id", "=", rootConversationId)
      .where("type", "=", "project_root")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return { root: conv.project_path, unavailable: false };
    if (typeof row.root !== "string") return null;
    return { root: row.root, unavailable: row.unavailable !== false };
  }

  /** The workspace root of a conversation's latest `device_paths` event, or null. */
  private async recordedWorkspace(conversationId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("conversation_events")
      .select(sql<string | null>`payload->'roots'->>'workspace'`.as("workspace"))
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "device_paths")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.workspace ?? null;
  }

  /** The owner's home the device's provider last reported (`devices.report`), or null. */
  private async reportedHome(orgId: string, deviceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("devices")
      .select("report")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return storedReport(row?.report)?.home ?? null;
  }

  /**
   * The owner's live device's project scope: whether its provider offers projects (it has
   * `list`), the home its provider last reported (the base the picker starts from; null: none,
   * the workspace) and the workspace as last known (the instance's handle). What a project path
   * may be is the provider's rule (device-provider spec §6.1): it refuses one it will not serve,
   * so the kernel narrows no path below a reported home.
   */
  async projectScope(orgId: string, accountId: string, deviceId: string): Promise<Scope> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select(["e.provider", "e.report", "i.handle"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) throw deviceNotFound();
    const { mode } = await this.devicePolicy({ orgId, deviceId });
    const home = storedReport(row.report)?.home ?? null;
    const impl = this.providers.forDevice(row.provider)?.impl;
    const handle = row.handle as SandboxHandle | null;
    return {
      mode,
      workspace: handle === null ? DEFAULT_SANDBOX_ROOTS.workspace : rootsOf(handle).workspace,
      home,
      supported: typeof impl?.list === "function",
    };
  }

  async resolveProjectForBinding(
    orgId: string,
    deviceId: string,
    accountId: string,
    name: string,
  ): Promise<{ name: string; path: string }> {
    const scope = await this.projectScope(orgId, accountId, deviceId);
    if (!scope.supported) throw projectsUnsupported();
    const row = await this.readProject(orgId, deviceId, name);
    if (row === null) throw projectNotFound(name);
    // a home reported after the project was added can put it above the home: the working root
    // would fall back for it, so it is not bound (the add rule, project root §4.3)
    if (aboveHome(row.path, scope.home)) throw tooBroad(row.name);
    return { name: row.name, path: row.path };
  }

  async projectMatches(deviceId: string, name: string, path: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("device_projects")
      .select("name")
      .where("device_id", "=", deviceId)
      .where("name", "=", name)
      .where("path", "=", path)
      .executeTakeFirst();
    return row !== undefined;
  }

  async scope(orgId: string, deviceId: string, projectPath: string | null, project: string | null) {
    const { sandbox } = await this.readDevice(orgId, deviceId);
    const availability = await this.availability(orgId, deviceId);
    // A ceiling restored to the same values is still a new authorization decision. Reads do
    // not initialize epoch rows; absent rows denote the pre-change revision zero.
    const epochRows = await this.db
      .selectFrom("permission_authority_epochs")
      .select(["kind", "id", "full_revision"])
      .where((eb) =>
        eb.or([
          eb.and([eb("kind", "=", "platform"), eb("id", "=", "platform")]),
          eb.and([eb("kind", "=", "org"), eb("id", "=", orgId)]),
          eb.and([eb("kind", "=", "device"), eb("id", "=", deviceId)]),
        ]),
      )
      .execute();
    const authority = { platform: 0, org: 0, device: 0 };
    for (const row of epochRows)
      if (row.kind === "platform" || row.kind === "org" || row.kind === "device")
        authority[row.kind] = row.full_revision;
    // the consent fingerprint: the device, the project binding and the crossing ceilings Full
    // access auto-approves within (approval-only profiles design, "Consent fingerprint"), read
    // from exactly the layer the ceilings read (the current runtime support, else the stored one,
    // else no crossing): a support that allows a crossing the consent did not cover outgrows it,
    // so Full access never auto-approves past what the person confirmed
    const consentReach = (await this.deviceSandboxFacts(orgId, deviceId, availability)).reach;
    // what a consent is bound to besides the reach: the device, the project binding and the
    // epochs a widening writer bumps (a ceiling restored to the same values still resets; an
    // instance committed on other roots than the device's previous one bumps the device epoch)
    const consentIdentity = permissionScopeHash({ authority, deviceId, projectPath });
    const scopeRevision = permissionScopeHash({
      identity: consentIdentity,
      orgHosts: this.config.get().sandbox.limits.orgHosts,
      sandbox: consentReach,
    });
    return {
      deviceId,
      project,
      scopeRevision,
      consentIdentity,
      consentReach,
      availability,
      sandbox,
      outsideSandboxCeiling: sandbox.outsideSandbox,
    };
  }
  /**
   * The preview people see before choosing a profile: availability is the device-work verdict
   * ({@link deviceWorkAvailability}). Kernel callers only use it as a check. `consentReach` is the
   * reach an Auto consent confirmed against this `scopeRevision` records (the same layer as the
   * crossing ceilings, whatever the runtime's state): the confirmation names exactly what it
   * covers, never a guess from the runtime availability.
   */
  async preview(orgId: string, accountId: string, deviceId: string, project?: string) {
    await this.devices.usable(orgId, accountId, deviceId);
    const binding =
      project === undefined
        ? null
        : await this.resolveProjectForBinding(orgId, deviceId, accountId, project);
    const scope = await this.scope(orgId, deviceId, binding?.path ?? null, project ?? null);
    return { ...scope, availability: deviceWorkAvailability(scope.availability) };
  }
  async view(orgId: string, accountId: string, row: PermissionRoot) {
    return (await this.viewWithAccess(orgId, accountId, row)).view;
  }
  /**
   * {@link view} as people see it (`GET …/permissions`): availability is the device-work verdict
   * admission applies ({@link deviceWorkAvailability}), so a device whose runtime cannot enforce
   * its sandbox reads `unsupported` with the runtime cause. Kernel readers use {@link view}.
   */
  async peopleView(orgId: string, accountId: string, row: PermissionRoot) {
    const { view, previewed } = await this.viewWithAccess(orgId, accountId, row);
    return previewed ? { ...view, availability: deviceWorkAvailability(view.availability) } : view;
  }
  /**
   * {@link view} plus how the actor reached the root's device: none selected, usable, refused for
   * this actor (`device.not_found`: not its device), or its provider is not the current one. The
   * recorded permission context needs the distinction; the view itself stays unchanged.
   */
  async viewWithAccess(orgId: string, accountId: string, row: PermissionRoot) {
    let preview: Awaited<ReturnType<PermissionFacts["scope"]>> | null = null;
    let unavailableReason = "Choose a device to run device operations";
    let access: "no-device" | "device" | "actor-device-access" | "provider-unavailable" =
      "no-device";
    if (row.device_id) {
      try {
        await this.devices.usable(orgId, accountId, row.device_id);
        preview = await this.scope(orgId, row.device_id, row.project_path, row.project_name);
        access = "device";
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["device.not_found", "device.unavailable"].includes(error.code)
        )
          throw error;
        unavailableReason = error.message;
        access = error.code === "device.not_found" ? "actor-device-access" : "provider-unavailable";
      }
    }
    const consent = row.permission_consent as StoredConsent | null;
    // Auto holds whatever the device supports (device tools refuse at admission instead) and
    // without a device (no consent row, ruling R8); with a device it needs that device to be
    // reachable and its consent to still cover the device's ceilings
    const profile: PermissionProfile =
      row.permission_profile === "full-access" &&
      row.device_id !== null &&
      (!preview || !consentHolds(consent, row.device_id, preview))
        ? "approve-for-me"
        : row.permission_profile;
    return {
      access,
      /** Whether the device's scope was read (a usable device): its availability is a verdict. */
      previewed: preview !== null,
      view: {
        profile,
        revision: row.permission_revision,
        rootConversationId: row.id,
        deviceId: row.device_id,
        consentScope:
          profile === "full-access" && consent
            ? { deviceId: consent.deviceId, scopeRevision: consent.scopeRevision }
            : null,
        scopeRevision: preview?.scopeRevision ?? null,
        availability: preview?.availability ?? {
          state: "unsupported" as const,
          reason: unavailableReason,
          cause: { kind: "runtime" as const },
        },
        outsideSandboxCeiling: preview?.outsideSandboxCeiling ?? false,
        /** What an Auto consent confirmed now records (the confirmation names exactly this). */
        consentReach: preview?.consentReach ?? null,
        sandbox: preview?.sandbox ?? null,
        startingWorkNotice: notice,
      },
    };
  }

  /**
   * The installed environment of the device's current instance (B1 adapter), read under the
   * caller's device authority lock: its provider's current runtime report recorded with the
   * kernel-built identity ({@link readCurrentReport}, which binds the device's report revision),
   * the same for every provider. Null whenever it cannot be proved: no live instance (none,
   * creating, destroyed), an instance of another provider than the device's, roots differing from
   * the committed ones, missing or stale evidence, desired limits waiting for a file reset
   * (`unapplied`) and applied limits more permissive than the effective desired ones in any
   * dimension (network kind, a host the desired allowlist does not cover; spec §124): a pending
   * desired change is never projected as installed. Applied limits narrower than desired stand;
   * the next use's lifecycle lease applies any change before admitting an operation, and its new
   * limits change the identity, so that use records the evidence again. Never desired policy,
   * never a provider call, probe, resume or provisioning; a suspended instance is read as
   * recorded.
   */
  async readAppliedEnvironmentLocked(input: {
    orgId: string;
    deviceId: string;
  }): Promise<AppliedEnvironment | null> {
    assertAuthorityHeld("device", input.deviceId);
    return this.readAppliedEnvironment(input);
  }

  /**
   * {@link readAppliedEnvironmentLocked} without the authority locks: a managed operation's held
   * evidence only (read under its lifecycle lease), which the managed writer validates again
   * under the locks. Never a basis for admission or a recorded context.
   */
  async readHeldEnvironment(input: {
    orgId: string;
    deviceId: string;
  }): Promise<AppliedEnvironment | null> {
    return this.readAppliedEnvironment(input);
  }

  private async readAppliedEnvironment(input: {
    orgId: string;
    deviceId: string;
  }): Promise<AppliedEnvironment | null> {
    const device = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", input.deviceId)
      .where("org_id", "=", input.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!device) return null;
    const instance = await this.db
      .selectFrom("device_instances")
      .select([
        "provider",
        "status",
        "handle",
        "created_at",
        "permission_roots",
        "permission_runtime_identity",
        "instance_limits",
      ])
      .where("device_id", "=", input.deviceId)
      .where("org_id", "=", input.orgId)
      .executeTakeFirst();
    if (
      !instance?.provider ||
      !instance.handle ||
      !instance.permission_roots ||
      !instance.permission_runtime_identity ||
      (instance.status !== "running" && instance.status !== "suspended") ||
      device.provider !== instance.provider
    )
      return null;
    const roots = rootsOf(instance.handle);
    const committed = instance.permission_roots;
    if (
      committed.workspace !== roots.workspace ||
      committed.skills !== roots.skills ||
      committed.tmp !== roots.tmp
    )
      return null;
    const entry = this.providers.forDevice(device.provider);
    if (!entry || entry.plugin !== instance.provider) return null;
    const evidence = await readCurrentReport(
      this.db.db,
      input.deviceId,
      entry.plugin,
      entry.version,
    );
    if (evidence.identityHash === null || evidence.support === null) return null;
    const limits = readInstanceLimits(instance.instance_limits);
    if (limits.applied === null || limits.unapplied !== null) return null;
    // an operation-boundary runtime holds its outer boundary per operation in its host
    // environment (the operation's own network field restricts it); an instance-boundary one's
    // outer boundary is its applied instance network
    const boundary = evidence.support.boundary;
    // an instance's applied limits more permissive than the effective desired ones (spec §124)
    // are not the installed authority: unproved until the next use's lifecycle lease applies the
    // narrowing (an operation-boundary runtime's operations carry their own network)
    if (
      boundary === "instance" &&
      appliedWider(limits.applied, appliedOf(await this.devicePolicy(input)))
    )
      return null;
    const outerNetwork: AppliedOuterNetwork | null =
      boundary === "operation"
        ? { kind: "host-environment" }
        : instanceOuterNetwork(limits.applied.network);
    if (outerNetwork === null) return null;
    return {
      revision: evidence.identityHash,
      boundary,
      provider: instance.provider,
      instanceId: instance.handle.id,
      instanceGeneration: String(instance.created_at.getTime()),
      roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
      outerNetwork,
    };
  }
}

/**
 * The outer boundary an instance-boundary instance's applied network proves: public addresses, or
 * its exact allowlist (empty: network disabled). Null when the allowlist cannot be stated as
 * recorded context hosts (a host that is not a normalized authority host, or more than the cap).
 */
export function instanceOuterNetwork(network: DeviceNetwork): AppliedOuterNetwork | null {
  if (network.kind === "open-public") return { kind: "open-public" };
  const hosts = [...new Set(network.hosts)].sort(permissionCodePointCompare);
  if (hosts.length === 0) return { kind: "none" };
  if (hosts.length > 100 || hosts.some((host) => validateAllowHost(host).length > 0)) return null;
  return { kind: "allowlist", hosts };
}

/**
 * Restricted hosts within an instance's applied outer boundary (narrowing only): a host the outer
 * allowlist does not cover cannot be reached, so neither admission nor the recorded context names
 * it. An operation-boundary runtime's host environment keeps every host.
 */
export function hostsWithinOuter(
  hosts: readonly string[],
  outer: AppliedOuterNetwork | undefined,
): string[] {
  if (!outer || outer.kind === "host-environment" || outer.kind === "open-public")
    return [...hosts];
  if (outer.kind === "none") return [];
  return hosts.filter((host) => outer.hosts.some((pattern) => coversHost(pattern, host)));
}

/**
 * The network a device sandbox gives an instance's outer boundary: the open public internet, or
 * its allowlist (empty under the kill switch, which closes it).
 */
export function networkOfSandbox(box: DeviceSandbox): DeviceNetwork {
  if (box.networkMode === "open") return { kind: "open-public", hosts: [] };
  return { kind: "allowlist", hosts: box.networkMode === "allowlist" ? [...box.hosts] : [] };
}

/**
 * A device's own sandbox network, whatever its provider: its stored choice (`network_mode`,
 * `network_hosts`; null follows the org). A B1 snapshot is copied into it by migrations 0165 and
 * 0167, the snapshot writer and every publication (`copyCloudSnapshotNetworks`), never read here.
 */
export function ownNetwork(row: { network_mode?: unknown; network_hosts?: unknown } | undefined): {
  networkMode: "open" | "allowlist" | "none" | null;
  networkHosts: string[];
} {
  const hosts = row?.network_hosts;
  const mode = row?.network_mode;
  if (mode === "open" || mode === "allowlist" || mode === "none")
    return {
      networkMode: mode,
      networkHosts: Array.isArray(hosts) && hosts.every((h) => typeof h === "string") ? hosts : [],
    };
  return { networkMode: null, networkHosts: [] };
}

/**
 * A stored Full access consent (`conversations.permission_consent`): the displayed scope revision
 * the person confirmed, and what it covered, so a narrowing keeps it and only a widening needs a new
 * one (approval-only profiles design, "Profiles" and "Consent fingerprint").
 */
export interface StoredConsent {
  deviceId: string;
  scopeRevision: string;
  /** The device, project binding and widening epochs it is bound to. */
  identity?: string;
  /** The crossing ceilings it covered. */
  reach?: ConsentReach;
}

/**
 * Whether a stored consent still covers the device's current crossing ceilings: the same device,
 * and either the exact scope it confirmed or the same identity with every ceiling within what it
 * covered (a narrowing never drops Full access to Approve for me).
 */
export function consentHolds(
  consent: StoredConsent | null,
  deviceId: string | null,
  preview: { scopeRevision: string; consentIdentity: string; consentReach: ConsentReach },
): boolean {
  if (consent === null || consent.deviceId !== deviceId) return false;
  if (consent.scopeRevision === preview.scopeRevision) return true;
  return (
    consent.identity === preview.consentIdentity &&
    consent.reach !== undefined &&
    reachWithin(preview.consentReach, consent.reach)
  );
}
