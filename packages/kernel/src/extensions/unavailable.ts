import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { STALE_RECONCILE_PERIODS } from "./lifecycle-topics.js";
import { type DeploymentExtensionStatus, deriveExtensionStatus } from "./permission-view.js";
import { ExtensionRegistry } from "./registry.js";

/**
 * Why an extension cannot be used right now (Platform tool spec §14.2 problem 1, §14.5 item 4):
 * - `not_deployed`: no install record on the platform (a catalog plugin whose extension was never
 *   installed);
 * - `needs_deployment_config`: installed, its deployment config is missing or invalid;
 * - `pending_approval`: its permissions wait for the super admin's approval;
 * - `pending_migration` / `loading`: the platform is still bringing it up;
 * - `dependency`: an extension point it requires has no loaded provider;
 * - `failed`: it failed to load (or its package cannot be read);
 * - `deployment_disabled`: the super admin disabled it on the platform.
 * State only: never a config value or field name.
 */
export type ExtensionUnavailableReason =
  | "not_deployed"
  | "needs_deployment_config"
  | "pending_approval"
  | "pending_migration"
  | "loading"
  | "dependency"
  | "failed"
  | "deployment_disabled";

/** The deployment status of an extension that is not loaded, and the reason it shows for it. */
export interface ExtensionUnavailability {
  /** Null when it has no install record (`not_deployed`). */
  status: DeploymentExtensionStatus | null;
  reason: ExtensionUnavailableReason;
}

/** The reason an org or the Platform tool shows for a deployment status of a not-loaded extension. */
export function unavailableReason(status: DeploymentExtensionStatus): ExtensionUnavailableReason {
  switch (status) {
    case "pending_config":
      return "needs_deployment_config";
    case "pending_approval":
      return "pending_approval";
    case "pending_migration":
      return "pending_migration";
    case "dependency":
      return "dependency";
    case "failed":
    case "legacy_format":
      return "failed";
    case "disabled":
      return "deployment_disabled";
    // loaded on another replica, or not yet on this one
    case "converging":
    case "enabled":
      return "loading";
  }
}

/**
 * The state of extensions that are not loaded on this replica, derived like the admin console's
 * status ({@link deriveExtensionStatus}) from the install record and the replicas' recent reports,
 * without reading packages: a pending approval and a pending config come from the replicas' rows
 * (`pending` with reason `approval` / `config`). Reads PG on every call (no in-process state).
 *
 * Its inputs differ slightly from the admin view's (`ExtensionAdmin`): there `pendingApproval`
 * compares the package's permission set with the snapshot and `configValid` checks the deployment
 * config, while here both come from what the replicas last reported. They agree once a replica
 * has tried the current package; until then this view says `loading` where the admin view may
 * already say `pending_approval` or `pending_config`.
 *
 * Which extensions count as loaded is this replica's registry: replica-local and transient. During
 * a rollout, or right after an enable or upgrade, one replica may answer `loading` while another
 * has it loaded; the next call (or the next reconcile) converges.
 */
@Injectable()
export class ExtensionAvailability {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
  ) {}

  /** For each of `names` not loaded on this replica: its status and reason (loaded ones absent). */
  async unavailable(names: readonly string[]): Promise<Map<string, ExtensionUnavailability>> {
    const loaded = new Set(this.registry.manifests().map((m) => m.name));
    const wanted = [...new Set(names)].filter((n) => !loaded.has(n));
    const out = new Map<string, ExtensionUnavailability>();
    if (wanted.length === 0) return out;
    const db = this.kdb.db;
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds;
    const [installs, replicas] = await Promise.all([
      db
        .selectFrom("extension_installs")
        .select(["name", "sha256", "desired_state", "migrated_sha"])
        .where("name", "in", wanted)
        .execute(),
      db
        .selectFrom("extension_replica_status")
        .select(["plugin", "state", "reason", "sha256"])
        .where("plugin", "in", wanted)
        .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
        .execute(),
    ]);
    for (const name of wanted) {
      const install = installs.find((i) => i.name === name);
      if (install === undefined) {
        out.set(name, { status: null, reason: "not_deployed" });
        continue;
      }
      const rows = replicas.filter((r) => r.plugin === name);
      const target = rows.filter((r) => r.sha256 === install.sha256);
      const status = deriveExtensionStatus({
        source: "install",
        desired: { sha256: install.sha256, state: install.desired_state },
        pendingApproval: target.some((r) => r.state === "pending" && r.reason === "approval"),
        configValid: !target.some((r) => r.state === "pending" && r.reason === "config"),
        migratedSha: install.migrated_sha,
        replicas: rows,
      });
      out.set(name, { status, reason: unavailableReason(status) });
    }
    return out;
  }
}
