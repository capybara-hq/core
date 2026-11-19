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
import {
  type DeviceProjectScope,
  outsideMode,
  projectNotFound,
  tooBroad,
  withinMode,
} from "../devices/project-rules.js";
import { aboveHome, type WorkingProject } from "../devices/working-root.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { ownerFactsOf, ownerModeOf } from "../local-devices/owner-report.js";
import { deviceFeaturesOf } from "../local-devices/policy-summary.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import {
  type ConsentReach,
  canonicalHostCeiling,
  type DeviceSandbox,
  type DeviceSandboxDeviceLayer,
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
  type PermissionAvailability,
  permissionAvailabilityFor,
} from "./permission-availability.js";
import type { AppliedEnvironment, AppliedOuterNetwork } from "./permission-context-types.js";
import {
  readCurrentReport,
  readRuntimeReport,
  sameRuntimeIdentity,
} from "./permission-runtime-reports.js";
import { providerForDevice, SandboxProviders } from "./providers.js";
import { homeOf } from "./review/rules.js";

type Scope = DeviceProjectScope;
/**
 * What decides the working root of a call (project root spec §4.3), read the same way for a
 * sandbox tool and for the command review, so both decide the same root.
 */
export interface WorkingFacts {
  /**
   * The device's workspace: the latest `device_paths` roots recorded in the calling conversation,
   * else the root's, else the machine's reported roots, else the default.
   */
  workspace: string;
  /** The owner's home: the machine's reported home, else the workspace's home prefix; null: unknown. */
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
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud" | "forName">,
    @Inject(DeviceAccess) private readonly devices: Pick<DeviceAccess, "usable">,
  ) {}
  /**
   * Current policy, the device sandbox and persisted owner roots; access is checked by the caller.
   * `sandbox` is the device sandbox under the device's current runtime report (the provider layer
   * assumed before one is recorded), the same under every permission profile.
   */
  async readDevice(orgId: string, deviceId: string) {
    const [policy, machine, availability] = await Promise.all([
      this.devicePolicy({ orgId, deviceId }),
      this.db
        .selectFrom("device_machines")
        .select(["local_policy", "owner_report", "roots", "home"])
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .where("revoked_at", "is", null)
        .executeTakeFirst(),
      this.availability(orgId, deviceId),
    ]);
    const facts = machine ? ownerFactsOf(machine) : null;
    const owner =
      facts === null || facts.state === "missing"
        ? null
        : {
            state: facts.state,
            outsideSandbox: facts.outsideSandbox,
            restrictedProjectReach: facts.restrictedProjectReach,
            network: facts.network,
            allowedDomains: facts.allowedDomains,
          };
    const sandbox = await this.deviceSandboxFacts(orgId, deviceId, availability);
    return {
      policy,
      // the owner's authenticated facts (B2); null when the machine reported nothing readable
      owner,
      sandbox: sandbox.box,
      hostCeiling: sandbox.hostCeiling,
      hostRefusal: sandbox.refusal,
      reach: sandbox.reach,
      roots: machine?.roots ?? null,
      home: machine?.home ?? null,
    };
  }

  /**
   * The effective device sandbox (approval-only profiles design, "Settings model"): the platform,
   * org, device and provider layers read live and combined by {@link effectiveDeviceSandbox}. A
   * local device's layer is its owner's authenticated report (missing or blocked: fail closed,
   * nothing outside and the allowlist); a cloud device's is its stored network choice.
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
    /** A cloud device's network as it would be stored (a change checked before it is written). */
    cloudNetwork?: { networkMode: "open" | "allowlist" | "none" | null; networkHosts: string[] },
  ) {
    const [settings, org, row] = await Promise.all([
      readDeviceSandboxSettings(this.db.db, this.config),
      readOrgSettings(this.db.db, orgId),
      this.db
        .selectFrom("devices as e")
        .leftJoin("device_machines as m", (j) =>
          j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
        )
        .select(["e.source", "e.network_mode", "e.network_hosts", "m.owner_report"])
        .where("e.id", "=", deviceId)
        .where("e.org_id", "=", orgId)
        .executeTakeFirst(),
    ]);
    const location = row?.source === "local" ? "local" : "cloud";
    const limits = this.config.get().sandbox.limits;
    let device: DeviceSandboxDeviceLayer;
    let owner: { network: "open" | "allowlist"; allowedDomains: readonly string[] } | null = null;
    if (location === "local") {
      const facts = ownerFactsOf(row ?? {});
      owner = { network: facts.network, allowedDomains: facts.allowedDomains };
      device = {
        location,
        outsideSandbox: facts.outsideSandbox,
        network: facts.network,
        allowedDomains: facts.allowedDomains,
        restrictedProjectReach: facts.restrictedProjectReach,
      };
    } else device = { location, ...(cloudNetwork ?? cloudOwnNetwork(row)) };
    const current = availability ?? (await this.availability(orgId, deviceId));
    const report = current.state === "supported" ? current.report : null;
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
      device,
      providerLayerOf(report, location),
    );
    const hostCeiling = hostGrantCeiling(box, platform, orgLayer, owner);
    return {
      box,
      hostCeiling,
      /** The org's effective hosts: what a device's own host list may narrow, never add to. */
      orgHosts: orgHostsOf(platform, orgLayer),
      refusal: (host: string) => hostGrantRefusal(host, box, platform, orgLayer, owner),
      reach: {
        outsideSandbox: box.outsideSandbox,
        networkCeiling: box.networkCeiling,
        networkMode: box.networkMode,
        restrictedProjectReach: box.restrictedProjectReach,
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
      { location: "cloud", networkMode: null, networkHosts: [] },
      {
        boundary: "operation",
        network: { openPublic: true, allowlist: true, perOperationHosts: true },
        outsideSandbox: false,
      },
    );
    return hostGrantCeiling(box, platform, orgLayer, null);
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
   * a cloud instance's applied limits and deciding the working root's reach) and the network a
   * cloud instance is created with. A cloud device's network is its device sandbox network
   * ({@link deviceSandbox}); the B1 snapshot's `outer_network` is no longer read: migrations 0163
   * and 0165 and the snapshot writer copy an allowlist snapshot into the device's own network
   * choice (`network_mode`, `network_hosts`).
   */
  async devicePolicy(device: { orgId: string; deviceId?: string }): Promise<EffectiveDevicePolicy> {
    const [deployment, settings, chosen] = await Promise.all([
      readDeploymentDevicePolicy(this.db.db, this.config),
      readOrgSettings(this.db.db, device.orgId),
      device.deviceId === undefined
        ? { mode: null, source: null }
        : this.deviceChosenMode(device.orgId, device.deviceId),
    ]);
    const policy = effectiveDevicePolicy(deployment, settings, chosen.mode);
    if (chosen.source !== "cloud" || device.deviceId === undefined) return policy;
    // a cloud instance's outer network is its sandbox network (its provider enforces it, read
    // under the provider layer assumed before a report); a local device's commands carry its
    // sandbox network in their limits (`SandboxService.deviceLimits`)
    const box = await this.deviceSandbox(device.orgId, device.deviceId, {
      state: "unprobed",
      reason: "lifecycle",
    });
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
   * Refuses new authority on a local device whose machine regressed its owner report sequence on
   * a new connection or sent conflicting reports (B2): only a valid current report or a new
   * login clears it. Late deliveries of older reports are ignored, never blocking.
   */
  async assertOwnerReportUsable(orgId: string, deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("device_machines")
      .select(["owner_report", "local_policy"])
      .where("device_id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (row && ownerFactsOf(row).state === "blocked")
      throw new ApiError(
        "device.owner_report_stale",
        "This device's machine reported an owner ceiling older than the one it reported before (its owner report sequence was lost or reset); run capybara-device login again on that machine to reset it",
      );
  }

  /**
   * The mode tier a device chose: a local device's derived one (`ownerModeOf`: `auto` only when
   * its owner allows running outside the sandbox); a cloud device's narrower of its old switch and
   * its B1 owner snapshot (`cloudChosenMode`), or null for a cloud device that follows the
   * platform and the org. The tier is kernel-internal (instance limits, reach): a cloud device
   * never runs outside its sandbox.
   */
  private async deviceChosenMode(
    orgId: string,
    deviceId: string,
  ): Promise<{
    mode: EffectiveDevicePolicy["mode"] | null;
    source: "local" | "cloud" | null;
  }> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.source", "e.mode", "e.owner_full_access", "m.owner_report"])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return { mode: null, source: null };
    if (row.source === "local") return { mode: ownerModeOf(row), source: "local" };
    return { mode: cloudChosenMode(row), source: "cloud" };
  }

  /**
   * The device's current permission availability: the provider's capability shape, then the
   * runtime report recorded for its current identity. No probe or provider call.
   */
  private async availability(orgId: string, deviceId: string): Promise<PermissionAvailability> {
    const device = await this.db
      .selectFrom("devices")
      .select(["provider", "source"])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const provider = device ? providerForDevice(this.providers, device.provider) : undefined;
    let availability = permissionAvailabilityFor(provider?.impl);
    if (availability.state === "unprobed" && provider) {
      const machine =
        provider.plugin === "@local"
          ? await this.db
              .selectFrom("device_machines")
              .select("program_version")
              .where("device_id", "=", deviceId)
              .where("revoked_at", "is", null)
              .executeTakeFirst()
          : undefined;
      availability = await readRuntimeReport(
        this.db.db,
        deviceId,
        provider.plugin,
        machine?.program_version ?? provider.version,
      );
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
    const [applied, recorded, recordedRoot, machine, project] = await Promise.all([
      this.readAppliedEnvironment({ orgId, deviceId }),
      this.recordedWorkspace(conversationId),
      conversationId === rootConversationId ? null : this.recordedWorkspace(rootConversationId),
      this.machineRoots(deviceId),
      this.workingProject(orgId, rootConversationId),
    ]);
    // the held instance's committed (and, local, installed) roots first: a recorded
    // `device_paths` may be stale (an earlier instance's), and the managed writer records the
    // device paths from these roots; the records only stand in while no instance is committed
    const workspace =
      applied?.roots.workspace ??
      recorded ??
      recordedRoot ??
      machine?.workspace ??
      DEFAULT_SANDBOX_ROOTS.workspace;
    // never from a project root: the machine's home, else the device workspace's home prefix
    const reported = machine?.home;
    const home = reported?.startsWith("/") ? reported : homeOf(workspace);
    return { workspace, home, project };
  }

  /**
   * The project snapshot that decides the working root of the conversation tree rooted at
   * `rootConversationId` (project root spec §4.3): its latest `project_root` event, read only when
   * the conversation is bound to a project (a free conversation reads one row by its key). Null:
   * free, or bound with no snapshot recorded yet.
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
    if (row === undefined || typeof row.root !== "string") return null;
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

  /**
   * The workspace root and the owner's home the device's active machine last reported, or null
   * (cloud: no machine).
   */
  private async machineRoots(
    deviceId: string,
  ): Promise<{ workspace: string | null; home: string | null } | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select([sql<string | null>`roots->>'workspace'`.as("workspace"), "home"])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row === undefined ? null : { workspace: row.workspace ?? null, home: row.home ?? null };
  }

  async projectScope(orgId: string, accountId: string, deviceId: string): Promise<Scope> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .leftJoin("device_instances as i", "i.device_id", "e.id")
      .select([
        "e.source",
        "e.provider",
        "m.features",
        "m.local_policy",
        "m.owner_report",
        "m.home",
        sql<string | null>`m.roots->>'workspace'`.as("machine_workspace"),
        "i.handle",
      ])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.owner_kind", "=", "personal")
      .where("e.owner_account_id", "=", accountId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) throw deviceNotFound();
    // `devicePolicy`, not `modeLevel` as the command review reads: a cloud device with a pending
    // files reset is scoped by the narrower mode it will run at, never the wider one its instance
    // still has, on purpose (projects are offered for what the device will read; no effect today)
    const { mode, allowedMode } = await this.devicePolicy({ orgId, deviceId });
    if (row.source === "local") {
      const owner = ownerFactsOf(row);
      return {
        source: "local",
        mode,
        // B2: restricted reach follows the owner's reach, independent of its Full permission, and
        // only within a platform and org that allow the wider device ceiling
        reach:
          allowedMode === "auto" && owner.restrictedProjectReach === "os-user"
            ? "os-user"
            : "workspace",
        // an authenticated report bounds browsing by scope: never wider than the device allows
        workspace: row.machine_workspace ?? DEFAULT_SANDBOX_ROOTS.workspace,
        home: row.home,
        supported: deviceFeaturesOf(row.features).includes("projects"),
      };
    }
    const impl = providerForDevice(this.providers, row.provider)?.impl;
    const handle = row.handle as SandboxHandle | null;
    return {
      source: "cloud",
      mode,
      // cloud projects stay within their provisioned files
      reach: "workspace",
      workspace: handle === null ? DEFAULT_SANDBOX_ROOTS.workspace : rootsOf(handle).workspace,
      home: null,
      supported: typeof impl?.list === "function" && typeof impl.scan === "function",
    };
  }

  async resolveProjectForBinding(
    orgId: string,
    deviceId: string,
    accountId: string,
    name: string,
  ): Promise<{ name: string; path: string }> {
    const scope = await this.projectScope(orgId, accountId, deviceId);
    if (!scope.supported) throw projectsUnsupported(scope.source === "local");
    const row = await this.readProject(orgId, deviceId, name);
    if (row === null) throw projectNotFound(name);
    if (!withinMode(scope, row.path)) throw outsideMode(row.path, scope.mode);
    // a home reported after the project was added can put it above the home: the working root
    // would fall back for it, so it is not bound (the add rule, project root §4.3)
    if (aboveHome(row.path, scope.home)) throw tooBroad(row.path);
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
    const { roots: ownerRoots, sandbox, policy } = await this.readDevice(orgId, deviceId);
    const source = (
      await this.db
        .selectFrom("devices")
        .select("source")
        .where("id", "=", deviceId)
        .where("org_id", "=", orgId)
        .executeTakeFirst()
    )?.source;
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
    const instanceRoots = await this.db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    // the consent fingerprint: the device, the project binding and the crossing ceilings Full
    // access auto-approves within (approval-only profiles design, "Consent fingerprint"), from
    // the settings layers under the provider layer assumed before a report: a runtime report
    // arriving or changing only narrows what the consent covers, so it never resets it
    const consentReach = (
      await this.deviceSandboxFacts(orgId, deviceId, { state: "unprobed", reason: "consent" })
    ).reach;
    // what a consent is bound to besides the reach: the device, the project binding and the
    // epochs a widening writer bumps (a ceiling restored to the same values still resets)
    const consentIdentity = permissionScopeHash({
      authority,
      deviceId,
      projectPath,
      workingRoot:
        projectPath ??
        (ownerRoots as { workspace?: string } | null)?.workspace ??
        rootsOf(instanceRoots?.handle ?? { id: deviceId }).workspace,
    });
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
      // B2: broad restricted reach (directories outside the working root) is the owner's reach
      // within the platform and org ceilings; a cloud instance's whole filesystem is its sandbox,
      // and an operation-boundary cloud device keeps its previous rule (its mode tier)
      broadProjectReach:
        sandbox.boundary === "instance" ||
        (source === "local"
          ? sandbox.restrictedProjectReach === "os-user"
          : policy.mode === "auto" && policy.allowedMode === "auto"),
    };
  }
  async preview(orgId: string, accountId: string, deviceId: string, project?: string) {
    await this.devices.usable(orgId, accountId, deviceId);
    const binding =
      project === undefined
        ? null
        : await this.resolveProjectForBinding(orgId, deviceId, accountId, project);
    return this.scope(orgId, deviceId, binding?.path ?? null, project ?? null);
  }
  async view(orgId: string, accountId: string, row: PermissionRoot) {
    return (await this.viewWithAccess(orgId, accountId, row)).view;
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
    const profile: PermissionProfile =
      row.permission_profile === "full-access" &&
      (!preview ||
        preview.availability.state === "unsupported" ||
        !consentHolds(consent, row.device_id, preview))
        ? "approve-for-me"
        : row.permission_profile;
    return {
      access,
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
        },
        outsideSandboxCeiling: preview?.outsideSandboxCeiling ?? false,
        broadProjectReach: preview?.broadProjectReach ?? false,
        sandbox: preview?.sandbox ?? null,
        startingWorkNotice: notice,
      },
    };
  }

  /**
   * The installed environment of the device's current instance (B1 adapter over the Task 8 B4
   * installed binding and its current runtime attestation), read under the caller's device
   * authority lock. Null whenever it cannot be proved: no live instance (none, creating,
   * destroyed), no installed binding of exactly this generation, a binding of another provider or
   * machine, a runtime identity differing from the bound one, roots differing from the committed
   * ones. A cloud device proves it by its kernel-recorded cloud evidence instead (B-15,
   * {@link cloudAppliedLocked}). Never desired policy, never a provider call, probe, resume or
   * provisioning; a suspended instance is read as recorded.
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
      .select(["source", "provider"])
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
      (device.provider !== null && device.provider !== instance.provider)
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
    if (device.source !== "local")
      return this.cloudAppliedLocked(input, {
        ...instance,
        provider: instance.provider,
        handle: instance.handle,
      });
    const instanceGeneration = String(instance.created_at.getTime());
    const [binding, machine] = await Promise.all([
      this.db
        .selectFrom("device_instance_bindings")
        .select(["binding_id", "provider", "status", "machine_id", "runtime_identity"])
        .where("device_id", "=", input.deviceId)
        .where("instance_generation", "=", instanceGeneration)
        .executeTakeFirst(),
      this.db
        .selectFrom("device_machines")
        .select("id")
        .where("device_id", "=", input.deviceId)
        .where("org_id", "=", input.orgId)
        .where("revoked_at", "is", null)
        .executeTakeFirst(),
    ]);
    if (
      binding?.status !== "installed" ||
      binding.provider !== instance.provider ||
      !binding.runtime_identity ||
      !machine ||
      binding.machine_id !== machine.id ||
      !sameRuntimeIdentity(binding.runtime_identity, instance.permission_runtime_identity)
    )
      return null;
    return {
      location: "local",
      provider: instance.provider,
      instanceId: instance.handle.id,
      instanceGeneration,
      bindingId: binding.binding_id,
      roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
      // a local device's outer boundary is its host environment; restricted rules are the
      // operation's own network field, never an outer network-off
      outerNetwork: { kind: "host-environment" },
    };
  }

  /**
   * A cloud instance's installed environment (B-15, Q1 option A): its current runtime report
   * recorded with the kernel-built cloud identity (provider plugin and version, handle,
   * generation, applied limits; `readCurrentReport`), named by that report's identity hash in
   * place of a binding id. Null while the evidence is missing or stale, while desired limits wait
   * for a file reset (`unapplied`) and while the applied limits are more permissive than the
   * effective desired ones in any dimension (mode, network kind, a host the desired allowlist
   * does not cover; spec §124): a pending desired change is never projected as installed. Applied
   * limits narrower than desired stand (the outer boundary is the applied network, and restricted
   * hosts are cut to it); the next use's lifecycle lease applies any change before admitting an
   * operation, and its new limits change the identity, so that use records the evidence again.
   */
  private async cloudAppliedLocked(
    input: { orgId: string; deviceId: string },
    instance: {
      provider: string;
      handle: SandboxHandle;
      created_at: Date;
      instance_limits: unknown;
    },
  ): Promise<AppliedEnvironment | null> {
    const device = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", input.deviceId)
      .executeTakeFirst();
    const entry = providerForDevice(this.providers, device?.provider ?? null);
    if (!entry || entry.plugin !== instance.provider) return null;
    const evidence = await readCurrentReport(
      this.db.db,
      input.deviceId,
      entry.plugin,
      entry.version,
    );
    if (evidence.identityHash === null) return null;
    const limits = readInstanceLimits(instance.instance_limits);
    if (limits.applied === null || limits.unapplied !== null) return null;
    // applied limits more permissive than the effective desired ones (spec §124) are not the
    // installed authority: unproved until the next use's lifecycle lease applies the narrowing
    if (appliedWider(limits.applied, appliedOf(await this.devicePolicy(input)))) return null;
    const outerNetwork = cloudOuterNetwork(limits.applied.network);
    if (outerNetwork === null) return null;
    const roots = rootsOf(instance.handle);
    return {
      location: "cloud",
      provider: instance.provider,
      instanceId: instance.handle.id,
      instanceGeneration: String(instance.created_at.getTime()),
      bindingId: evidence.identityHash,
      roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
      outerNetwork,
    };
  }
}

/**
 * The outer boundary a cloud instance's applied network proves: public addresses, or its exact
 * allowlist (empty: network disabled). Null when the allowlist cannot be stated as recorded
 * context hosts (a host that is not a normalized authority host, or more than the cap).
 */
export function cloudOuterNetwork(network: DeviceNetwork): AppliedOuterNetwork | null {
  if (network.kind === "open-public") return { kind: "open-public" };
  const hosts = [...new Set(network.hosts)].sort(permissionCodePointCompare);
  if (hosts.length === 0) return { kind: "none" };
  if (hosts.length > 100 || hosts.some((host) => validateAllowHost(host).length > 0)) return null;
  return { kind: "allowlist", hosts };
}

/**
 * Restricted hosts within a cloud instance's applied outer boundary (narrowing only): a host the
 * outer allowlist does not cover cannot be reached, so neither admission nor the recorded context
 * names it. A local device's host environment keeps every host.
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
 * The network a device sandbox gives a cloud instance's outer boundary: the open public internet,
 * or its allowlist (empty under the kill switch, which closes it).
 */
export function networkOfSandbox(box: DeviceSandbox): DeviceNetwork {
  if (box.networkMode === "open") return { kind: "open-public", hosts: [] };
  return { kind: "allowlist", hosts: box.networkMode === "allowlist" ? [...box.hosts] : [] };
}

/**
 * A cloud device's own sandbox network: its stored choice (`network_mode`, `network_hosts`; null
 * follows the org). A B1 snapshot is copied into it by migrations 0163 and 0165, the snapshot
 * writer and every publication (`copyCloudSnapshotNetworks`), never read here.
 */
export function cloudOwnNetwork(
  row: { network_mode?: unknown; network_hosts?: unknown } | undefined,
): { networkMode: "open" | "allowlist" | "none" | null; networkHosts: string[] } {
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
