import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import {
  type DeviceFeature,
  type DeviceHello,
  type DeviceLocalPolicySummary,
  type DeviceOwnerCeiling,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { sameMachine } from "../dial-in/machines.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import {
  type PermissionRuntimeIdentity,
  PermissionRuntimeReports,
  sameRuntimeIdentity,
} from "../sandbox/permission-runtime-reports.js";
import { LOCAL_PROVIDER } from "../sandbox/providers.js";
import { OwnerReports } from "./owner-reports.js";
import {
  deviceFeaturesOf,
  localPolicyDiff,
  localPolicyOf,
  opExplains,
  ownerPolicyRevokes,
  pendingPolicyOpsOf,
} from "./policy-summary.js";

/** Roots in a fixed key order (null when absent), whatever order jsonb stored them in. */
const canonicalRoots = (roots: unknown): string => {
  if (!roots || typeof roots !== "object") return "null";
  const r = roots as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]]),
  );
};

const ROOT_KEYS = ["workspace", "skills", "tmp"] as const;

/** Whether two sets of roots name the same three directories. */
export const sameRoots = (a: SandboxRoots, b: SandboxRoots): boolean =>
  ROOT_KEYS.every((k) => a[k] === b[k]);

const jsonOrNull = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));

/**
 * What a `capybara-device` machine reports about itself on the dial-in channel, recorded for the
 * kernel's own `@local` provider (interim: these local semantics leave the kernel with the
 * `device-local` plugin): its hello body (roots, mode, features, local policy summary, owner
 * report, runtime identity) and its `policy` events, on the device's machine row
 * (`device_machines`).
 */
@Injectable()
export class LocalMachineReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Inject(PermissionRuntimeReports) private readonly reports: PermissionRuntimeReports,
    @Inject(OwnerReports) private readonly owners: OwnerReports,
  ) {}

  /** The active machine's features and policy summary (null when no machine is connected). */
  async summary(
    deviceId: string,
  ): Promise<{ features: DeviceFeature[]; policy: DeviceLocalPolicySummary | null } | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select(["features", "local_policy"])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row
      ? { features: deviceFeaturesOf(row.features), policy: localPolicyOf(row.local_policy) }
      : null;
  }

  /**
   * The roots the device's active machine last reported in its hello, or null (no active
   * machine, or none reported yet).
   */
  async machineRoots(deviceId: string): Promise<SandboxRoots | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select("roots")
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const r = row?.roots as Partial<Record<(typeof ROOT_KEYS)[number], unknown>> | null | undefined;
    if (!r || typeof r !== "object") return null;
    if (!ROOT_KEYS.every((k) => typeof r[k] === "string")) return null;
    return r as SandboxRoots;
  }

  /**
   * Stores what the program reported in its hello body (its program facts, version, OS, boot, are
   * the envelope's: `DialInMachines.recordConnect`). On the machine's first hello, when it is the
   * same machine as the device's previous one (else `DialInMachines.issue` already counted the
   * reset) but serves another directory or mode (other roots, ruling R23), the device's files are
   * other files: `fs_resets` moves on (maintainer decision 2026-11-08), so conversations get the
   * files-reset notice. A previous machine that never said hello has no known roots: nothing to
   * compare. The reported features (known ones only) and local policy summary (null when absent or
   * malformed) replace the stored ones. The summary is the device's sandbox allowlist; a change of
   * what the owner sets, made on the machine while it was away, is audited `device.policy_changed`
   * (the owner ceiling's, `device.owner_ceiling_changed`) ({@link reportedPolicy}). The owner's home
   * directory (`home`) replaces the stored one too (null when the hello has none).
   */
  @Transactional()
  async recordHello(
    machineId: string,
    hello: Omit<DeviceHello, "permissionSupport" | "ownerCeiling" | "instanceGeneration">,
    /** A protocol 4 hello's authenticated owner report (B2): it, not the summary, decides publication. */
    owner?: { report: DeviceOwnerCeiling; connectionId: string | null },
  ): Promise<void> {
    const subject = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!subject) return;
    await this.ceilings.lock({ orgId: subject.org_id, deviceId: subject.device_id }, "device");
    const self = await this.db
      .selectFrom("device_machines")
      .select([
        "device_id",
        "org_id",
        "account_id",
        "name",
        "os",
        "arch",
        "roots",
        "created_at",
        "local_policy",
        "pending_policy_ops",
      ])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .where("org_id", "=", subject.org_id)
      .where("device_id", "=", subject.device_id)
      .forUpdate()
      .executeTakeFirst();
    if (self === undefined) return;
    if (self.roots === null) {
      const prev = await this.db
        .selectFrom("device_machines")
        .select(["name", "os", "arch", "mode"])
        .select(sql<boolean>`roots = ${JSON.stringify(hello.roots)}::jsonb`.as("same_roots"))
        .where("device_id", "=", self.device_id)
        .where("id", "!=", machineId)
        .where("created_at", "<=", self.created_at)
        .where("roots", "is not", null)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      if (
        prev !== undefined &&
        sameMachine(prev, self) &&
        (!prev.same_roots || prev.mode !== hello.mode)
      ) {
        await this.db
          .updateTable("device_instances")
          .set({ fs_resets: sql<number>`fs_resets + 1` })
          .where("device_id", "=", self.device_id)
          .execute();
      }
    }
    const policy = await this.reportedPolicy(machineId, self, hello.policy);
    // jsonb returns keys in its own order: compare roots canonically, or every reconnect would
    // look like a changed reach and reset Full consent (B4 consent stability)
    const rootsChanged = canonicalRoots(self.roots) !== canonicalRoots(hello.roots);
    if (owner !== undefined)
      await this.owners.recordLocked(machineId, owner.report, {
        connectionId: owner.connectionId,
        via: "hello",
        rootsChanged,
      });
    else if (
      rootsChanged ||
      JSON.stringify(localPolicyOf(self.local_policy)) !== JSON.stringify(policy)
    )
      await this.ceilings.publishLocked(
        { orgId: self.org_id, deviceId: self.device_id },
        "device",
        (scope, row) =>
          rootsChanged ||
          ownerPolicyRevokes(localPolicyOf(policy), scope, row.method, row.granted_hosts),
        rootsChanged,
      );
    await this.db
      .updateTable("device_machines")
      .set({
        mode: hello.mode,
        roots: JSON.stringify(hello.roots),
        session_isolation: hello.sessionIsolation,
        features: deviceFeaturesOf(hello.features),
        local_policy: jsonOrNull(policy),
        // the base of an auto-mode project's relative path (project root §4.2); absent: unknown
        home: hello.home ?? null,
        last_seen_at: sql<Date>`now()`,
      })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /**
   * A protocol 5 hello body on an authenticated connection that holds the device's lease:
   * validated, then recorded like {@link recordHello} with its owner report and the connection it
   * arrived on, and the runtime report its binding attests.
   */
  @Transactional()
  async recordHelloV3(
    machineId: string,
    body: unknown,
    connectionId: string | null = null,
  ): Promise<void> {
    const parsed = parseDeviceFrame(body, "hello");
    await this.recordHello(machineId, parsed, {
      report: parsed.ownerCeiling,
      connectionId,
    });
    const machine = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id", "program_version"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!machine) return;
    const subject = { orgId: machine.org_id, deviceId: machine.device_id };
    await this.ceilings.lock(subject, "device");
    const attested = await this.boundIdentityLocked(subject, machineId, parsed, connectionId);
    // the hello predates the binding its own connection installed: that install recorded the
    // report, which this hello's must not overwrite
    if (attested === "installed-here") return;
    await this.reports.record(
      machine.device_id,
      LOCAL_PROVIDER,
      machine.program_version ?? "",
      attested,
      parsed.permissionSupport,
    );
  }

  /**
   * The runtime identity a v3 hello may attest (B4): only a bound hello re-reporting exactly the
   * identity of the current instance generation's installed binding. An unbound hello, another
   * generation or a binding still awaiting the device attests nothing (unprobed; it never finishes
   * an installation, which only the bindInstance answer does).
   *
   * The machine the current generation was installed for no longer attesting it means its program
   * can never serve that generation again: a restarted program whose verified runtime differs from
   * the one its stored binding attested (every capybara-device upgrade changes the runtime bytes)
   * starts unbound, and the device refuses to rebind a generation under a changed runtime. The
   * instance is then replaced ({@link replaceUnattestedLocked}), so the next use creates and binds
   * a new generation under the new evidence instead of staying unprobed until a new login.
   *
   * A connection answers bindInstance before its own hello is recorded (the hello is recorded
   * after `ready`), so a binding installed on the hello's own connection is newer than the hello:
   * it is left as it is (`installed-here`), never replaced by the evidence the hello predates.
   */
  private async boundIdentityLocked(
    subject: { orgId: string; deviceId: string },
    machineId: string,
    hello: DeviceHello,
    connectionId: string | null,
  ): Promise<PermissionRuntimeIdentity | "installed-here" | undefined> {
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["provider", "status", "handle", "created_at", "permission_runtime_identity"])
      .where("device_id", "=", subject.deviceId)
      .executeTakeFirst();
    if (
      !instance ||
      instance.provider !== LOCAL_PROVIDER ||
      !instance.handle ||
      (instance.status !== "running" && instance.status !== "suspended")
    )
      return undefined;
    const generation = String(instance.created_at.getTime());
    const binding = await this.db
      .selectFrom("device_instance_bindings")
      .select(["status", "runtime_identity", "machine_id", "installed_connection_id"])
      .where("device_id", "=", subject.deviceId)
      .where("instance_generation", "=", generation)
      .executeTakeFirst();
    // not installed yet (the kernel's bindInstance finishes it), or installed for another machine
    // (a login replaced the instance already): nothing to attest, nothing to replace
    if (binding?.status !== "installed" || !binding.runtime_identity) return undefined;
    if (binding.machine_id !== machineId) return undefined;
    if (connectionId !== null && binding.installed_connection_id === connectionId)
      return "installed-here";
    const reported = hello.runtimeIdentity;
    if (
      hello.instanceGeneration === generation &&
      reported?.instanceGeneration === generation &&
      sameRuntimeIdentity(binding.runtime_identity, reported)
    )
      return reported;
    await this.replaceUnattestedLocked(subject);
    return undefined;
  }

  /**
   * Replaces a local instance whose installed binding its machine no longer attests (under the
   * device authority writer): the row forgets its instance (status `none`, no handle) and its
   * fence moves on, so a lifecycle holder of the old instance fails its next write; the device's
   * admission epoch advances, revoking every admitted or started operation of the old generation.
   * The files stay (the same machine and directory): the next use creates a new instance on them,
   * which the kernel binds under the program's new runtime evidence. Full consent is left to that
   * install, which resets it when the proven environment fingerprint changed: a fingerprint a
   * hello merely names proves nothing, and nothing is admitted before the install records a
   * report, so resetting here too would reset twice.
   */
  private async replaceUnattestedLocked(subject: {
    orgId: string;
    deviceId: string;
  }): Promise<void> {
    await this.ceilings.publishLocked(subject, "device", true, false);
    await this.db
      .updateTable("device_instances")
      .set((eb) => ({
        status: "none",
        handle: null,
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        generation: eb("generation", "+", 1),
        permission_runtime_identity: null,
      }))
      .where("device_id", "=", subject.deviceId)
      .execute();
  }

  /**
   * Stores the local policy summary a connected program pushed after its hello (a `policy` frame:
   * its policy file changed on the machine: its sandbox allowlist), read and audited as the hello's
   * ({@link recordHello}). A change the owner made on the machine is audited
   * `device.policy_changed`. The next sandbox call then records a
   * new `device_paths` event when the facts the model is told changed. A revoked machine is left
   * alone.
   */
  @Transactional()
  async recordPolicy(
    machineId: string,
    summary: DeviceLocalPolicySummary | undefined,
  ): Promise<void> {
    const subject = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!subject) return;
    await this.ceilings.lock({ orgId: subject.org_id, deviceId: subject.device_id }, "device");
    const self = await this.db
      .selectFrom("device_machines")
      .select(["device_id", "org_id", "account_id", "local_policy", "pending_policy_ops"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .where("org_id", "=", subject.org_id)
      .where("device_id", "=", subject.device_id)
      .forUpdate()
      .executeTakeFirst();
    if (self === undefined) return;
    const policy = await this.reportedPolicy(machineId, self, summary);
    if (JSON.stringify(localPolicyOf(self.local_policy)) !== JSON.stringify(policy))
      await this.ceilings.publishLocked(
        { orgId: self.org_id, deviceId: self.device_id },
        "device",
        (scope, row) =>
          ownerPolicyRevokes(localPolicyOf(policy), scope, row.method, row.granted_hosts),
        false,
      );
    await this.db
      .updateTable("device_machines")
      .set({ local_policy: jsonOrNull(policy), last_seen_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /**
   * A staged (v3) `policy` frame (B2): the summary is kept for the device page like protocol 2's,
   * while the authenticated owner report alone decides what changed ({@link OwnerReports}).
   */
  @Transactional()
  async recordPolicyV3(
    machineId: string,
    event: unknown,
    connectionId: string | null = null,
  ): Promise<void> {
    const parsed = parseDeviceFrame(event, "event");
    const subject = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id", "account_id", "local_policy", "pending_policy_ops"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!subject) return;
    await this.ceilings.lock({ orgId: subject.org_id, deviceId: subject.device_id }, "device");
    const policy = await this.reportedPolicy(
      machineId,
      { ...subject, device_id: subject.device_id },
      parsed.policy,
    );
    await this.db
      .updateTable("device_machines")
      .set({ local_policy: jsonOrNull(policy), last_seen_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
    await this.owners.recordLocked(machineId, parsed.ownerCeiling, {
      connectionId,
      via: "policy",
    });
  }

  /**
   * The summary to store for one a program reported (hello or `policy` frame): the parsed one, else
   * null. When both the stored and the reported summary are readable and what the owner sets
   * changed ({@link localPolicyDiff}) by no `policy` op the platform sent ({@link opExplains}: its
   * answer may come after the machine's own report), the owner changed it on the machine
   * (`capybara-device policy add|remove allowedDomains ...`): the host changes are audited
   * `device.policy_changed`, `via: "device"`, so the device page lists them beside the platform's
   * changes (an owner ceiling change is the owner report writer's, `device.owner_ceiling_changed`);
   * one an op explains is not audited here (the op's answer is). A summary reported again is no change. Runs in the caller's transaction,
   * with the machine's row locked.
   */
  private async reportedPolicy(
    machineId: string,
    self: {
      device_id: string;
      org_id: string;
      account_id: string;
      local_policy: unknown;
      pending_policy_ops: unknown;
    },
    reported: DeviceLocalPolicySummary | undefined,
  ): Promise<DeviceLocalPolicySummary | null> {
    const summary = localPolicyOf(reported);
    const prev = localPolicyOf(self.local_policy);
    const diff = summary !== null && prev !== null ? localPolicyDiff(prev, summary) : null;
    if (diff !== null) {
      const now = Date.now();
      const byOp = pendingPolicyOpsOf(self.pending_policy_ops).some(
        (op) => op.until > now && opExplains(op, diff),
      );
      if (byOp) return summary;
      const base = {
        actorAccountId: self.account_id,
        orgId: self.org_id,
        target: self.device_id,
      };
      if (diff.add.length > 0 || diff.remove.length > 0) {
        await audit(this.db.db, {
          ...base,
          action: "device.policy_changed",
          detail: {
            add: diff.add,
            remove: diff.remove,
            by: self.account_id,
            via: "device",
            machineId,
          },
        });
      }
      return summary;
    }
    return summary;
  }
}
