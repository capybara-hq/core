import { createHash } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type PermissionProfile,
  rootsOf,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
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
  cloudChosenMode,
  type DeviceNetwork,
  type EffectiveDevicePolicy,
  effectiveDevicePolicy,
  readDeploymentDevicePolicy,
} from "./modes.js";
import { permissionAvailabilityFor } from "./permission-availability.js";
import { readRuntimeReport } from "./permission-runtime-reports.js";
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
  /** Current policy and persisted owner roots; access is checked by the caller. */
  async readDevice(orgId: string, deviceId: string) {
    const [policy, machine] = await Promise.all([
      this.devicePolicy({ orgId, deviceId }),
      this.db
        .selectFrom("device_machines")
        .select(["local_policy", "owner_report", "roots", "home"])
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .where("revoked_at", "is", null)
        .executeTakeFirst(),
    ]);
    const facts = machine ? ownerFactsOf(machine) : null;
    return {
      policy,
      // the owner's authenticated facts (B2), or its protocol 2 summary translated exactly; null
      // when the machine reported nothing readable
      owner:
        facts === null || facts.state === "missing"
          ? null
          : {
              state: facts.state,
              fullAccess: facts.fullAccess,
              restrictedProjectReach: facts.restrictedProjectReach,
              allowedDomains: facts.restrictedAllowedDomains,
            },
      roots: machine?.roots ?? null,
      home: machine?.home ?? null,
    };
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
  async devicePolicy(device: { orgId: string; deviceId?: string }): Promise<EffectiveDevicePolicy> {
    const [deployment, settings, chosen] = await Promise.all([
      readDeploymentDevicePolicy(this.db.db, this.config),
      readOrgSettings(this.db.db, device.orgId),
      device.deviceId === undefined
        ? { mode: null, outer: null }
        : this.deviceChosenMode(device.orgId, device.deviceId),
    ]);
    return effectiveDevicePolicy(deployment, settings, chosen.mode, chosen.outer);
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
   * The mode a device chose: a local device's derived one (`localModeOf`, which never returns null
   * — a machine with no summary or no mode feature is sandbox); a cloud device's narrowing switch
   * (`devices.mode`, `sandbox` only), or null for a cloud device that follows the platform and the
   * org.
   */
  private async deviceChosenMode(
    orgId: string,
    deviceId: string,
  ): Promise<{ mode: EffectiveDevicePolicy["mode"] | null; outer: DeviceNetwork | null }> {
    const row = await this.db
      .selectFrom("devices as e")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select([
        "e.source",
        "e.mode",
        "e.owner_full_access",
        "e.outer_network",
        "m.features",
        "m.local_policy",
        "m.owner_report",
      ])
      .where("e.id", "=", deviceId)
      .where("e.org_id", "=", orgId)
      .where("e.deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return { mode: null, outer: null };
    if (row.source === "local") return { mode: ownerModeOf(row), outer: null };
    // a cloud device: its B1 owner ceiling and outer network once snapshotted
    return { mode: cloudChosenMode(row), outer: row.outer_network };
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
    const [recorded, recordedRoot, machine, project] = await Promise.all([
      this.recordedWorkspace(conversationId),
      conversationId === rootConversationId ? null : this.recordedWorkspace(rootConversationId),
      this.machineRoots(deviceId),
      this.workingProject(orgId, rootConversationId),
    ]);
    const workspace =
      recorded ?? recordedRoot ?? machine?.workspace ?? DEFAULT_SANDBOX_ROOTS.workspace;
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
        // protocol 2 only: an owner auto machine under an org that forbids it is not read unasked
        // (its wire reads unsandboxed); an authenticated report bounds browsing by scope instead
        widerThanAllowed:
          owner.state !== "report" && allowedMode === "sandbox" && ownerModeOf(row) === "auto",
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
      widerThanAllowed: false,
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
    const { policy, owner, roots: ownerRoots } = await this.readDevice(orgId, deviceId);
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
    const scopeRevision = permissionScopeHash({
      authority,
      deviceId,
      projectPath,
      workingRoot:
        projectPath ??
        (ownerRoots as { workspace?: string } | null)?.workspace ??
        rootsOf(instanceRoots?.handle ?? { id: deviceId }).workspace,
      mode: policy.mode,
      allowedMode: policy.allowedMode,
      network:
        device?.source === "local"
          ? { kind: "environment" }
          : { ...policy.network, hosts: [...policy.network.hosts].sort() },
    });
    return {
      deviceId,
      project,
      scopeRevision,
      availability,
      fullAccessCeiling: policy.mode === "auto" && policy.allowedMode === "auto",
      // B2: broad restricted reach (directories outside the working root) is the owner's reach
      // within the platform and org device ceiling, never the owner's Full permission; a cloud
      // device keeps its previous rule (its Full ceiling over its own files)
      broadProjectReach:
        device?.source === "local"
          ? policy.allowedMode === "auto" && owner?.restrictedProjectReach === "os-user"
          : policy.mode === "auto" && policy.allowedMode === "auto",
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
    let preview: Awaited<ReturnType<PermissionFacts["scope"]>> | null = null;
    let unavailableReason = "Choose a device to run device operations";
    if (row.device_id) {
      try {
        await this.devices.usable(orgId, accountId, row.device_id);
        preview = await this.scope(orgId, row.device_id, row.project_path, row.project_name);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["device.not_found", "device.unavailable"].includes(error.code)
        )
          throw error;
        unavailableReason = error.message;
      }
    }
    const consent = row.permission_consent as { deviceId: string; scopeRevision: string } | null;
    const profile: PermissionProfile =
      row.permission_profile === "full-access" &&
      (!preview?.fullAccessCeiling ||
        preview.availability.state === "unsupported" ||
        consent?.deviceId !== row.device_id ||
        consent?.scopeRevision !== preview.scopeRevision)
        ? "approve-for-me"
        : row.permission_profile;
    return {
      profile,
      revision: row.permission_revision,
      rootConversationId: row.id,
      deviceId: row.device_id,
      consentScope: profile === "full-access" ? consent : null,
      scopeRevision: preview?.scopeRevision ?? null,
      availability: preview?.availability ?? {
        state: "unsupported" as const,
        reason: unavailableReason,
      },
      fullAccessCeiling: preview?.fullAccessCeiling ?? false,
      broadProjectReach: preview?.broadProjectReach ?? false,
      startingWorkNotice: notice,
    };
  }
}
