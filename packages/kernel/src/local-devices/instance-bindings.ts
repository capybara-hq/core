import {
  type BindInstanceRequestV3,
  type BindInstanceResultV3,
  DeviceProtocolError,
  parseOperationResultV3,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { runOutsideTransaction, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LegacyRetirementStore } from "../sandbox/legacy-retirement.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import {
  PermissionRuntimeReports,
  runtimeIdentity,
} from "../sandbox/permission-runtime-reports.js";
import { LOCAL_PROVIDER, type SandboxInstanceBinder } from "../sandbox/providers.js";
import { OP_DEADLINE_MS } from "./local-device-provider.js";
import { OwnerReports } from "./owner-reports.js";
import { LocalDeviceRelay } from "./relay.js";

/** The committed binding of a local instance generation, as the coordinator sends it. */
export interface CommittedBinding {
  orgId: string;
  request: BindInstanceRequestV3;
  status: "awaiting-device" | "installed";
  /** The machine the binding was committed for (null: none was active). */
  machineId: string | null;
}

/** The binding cannot be completed; the instance stays unprobed and admits nothing. */
export class InstanceBindingError extends Error {
  override name = "InstanceBindingError";
}

/**
 * Post-commit binding of a local instance generation (permission runtime cutover B4, staged on the
 * v3 path; protocol 2 stays active). `commitHandle` allocated the generation and committed an
 * `awaiting-device` binding; before the lifecycle holder downgrades to shared use it calls
 * {@link bind}, which sends the private `bindInstance` RPC to the authenticated machine outside
 * any transaction and then, under the device authority writer, verifies the exact instance row,
 * generation, binding id and machine, records the runtime report and marks the binding
 * `installed`. A retry (reconnect, lost reply, another replica) resends the identical binding; it
 * never allocates a new generation. A delayed answer for an old generation cannot populate a
 * replacement row.
 */
@Injectable()
export class LocalInstanceBindings implements SandboxInstanceBinder {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LocalDeviceRelay)
    private readonly relay: Pick<LocalDeviceRelay, "callV3" | "connection">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Inject(PermissionRuntimeReports) private readonly reports: PermissionRuntimeReports,
    @Inject(OwnerReports) private readonly owners: Pick<OwnerReports, "recordLocked">,
    /** The durable legacy gate checked before any bind is sent (8.5). */
    @Inject(LegacyRetirementStore)
    private readonly retirement: Pick<LegacyRetirementStore, "hasUnresolved">,
  ) {}

  /** The binding committed for the device's current local instance, or null (no allocation). */
  async committed(deviceId: string): Promise<CommittedBinding | null> {
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["org_id", "handle", "provider", "created_at"])
      .where("device_id", "=", deviceId)
      .where("status", "in", ["running", "suspended"])
      .executeTakeFirst();
    if (!instance || instance.provider !== LOCAL_PROVIDER || !instance.handle) return null;
    const binding = await this.db
      .selectFrom("device_instance_bindings")
      .select(["instance_generation", "binding_id", "previous_generation", "status", "machine_id"])
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", String(instance.created_at.getTime()))
      .executeTakeFirst();
    if (!binding) return null;
    const row = { ...instance, ...binding };
    return {
      orgId: row.org_id,
      status: row.status,
      machineId: row.machine_id,
      request: {
        instanceId: instance.handle.id,
        instanceGeneration: row.instance_generation,
        bindingId: row.binding_id,
        expectedPreviousGeneration: row.previous_generation,
      },
    };
  }

  /**
   * Whether the device's current local instance generation has an installed binding (the staged
   * acquire path's shared-use condition). No committed binding reads as not installed.
   */
  async installed(deviceId: string): Promise<boolean> {
    return (await this.committed(deviceId))?.status === "installed";
  }

  /**
   * Sends the committed binding and installs the verified answer. The caller holds the device's
   * lifecycle lease; no transaction is open across the RPC.
   */
  async bind(deviceId: string, signal: AbortSignal): Promise<BindInstanceResultV3 | null> {
    // the device round trip may take the whole operation deadline: never inside a transaction
    if (this.txHost.current())
      throw new InstanceBindingError("bindInstance must not run inside a transaction");
    const found = await this.committed(deviceId);
    if (!found) throw new InstanceBindingError("No committed local instance to bind");
    if (found.status === "installed") return null;
    // the kernel's durable legacy gate (8.5): an old incarnation of this device that may still
    // run legacy work blocks every new binding; a new generation never clears it
    if (await this.retirement.hasUnresolved(deviceId))
      throw new InstanceBindingError(
        "The device has an unresolved legacy retirement obligation; no instance can be bound",
      );
    const machineId = await this.activeMachine(deviceId);
    let committed = found;
    // a re-login since the commit: the binding follows the machine it is sent to, before the
    // send, so a lost answer leaves the chain naming what that machine's device may have stored
    if (committed.machineId !== machineId) {
      await runOutsideTransaction(() => this.retarget(deviceId, committed, machineId));
      const again = await this.committed(deviceId);
      if (!again) throw new InstanceBindingError("No committed local instance to bind");
      committed = again;
    }
    const connection = await this.relay.connection(deviceId);
    const answer = parseOperationResultV3(
      "bindInstance",
      await this.relay.callV3(
        deviceId,
        "bindInstance",
        { ...committed.request },
        {
          deadlineMs: OP_DEADLINE_MS,
          signal,
          connection,
        },
      ),
      committed.request,
    ) as BindInstanceResultV3;
    await runOutsideTransaction(() =>
      this.install(deviceId, machineId, committed, answer, connection.connectionId),
    );
    return answer;
  }

  /**
   * Moves a still awaiting binding to the active machine: its previous becomes the last binding
   * committed for that machine. Under the device writer, against the exact generation and id.
   */
  @Transactional()
  async retarget(deviceId: string, committed: CommittedBinding, machineId: string): Promise<void> {
    await this.ceilings.lock({ orgId: committed.orgId, deviceId }, "device");
    const { instanceGeneration, bindingId } = committed.request;
    const previous = await this.db
      .selectFrom("device_instance_bindings")
      .select("instance_generation")
      .where("device_id", "=", deviceId)
      .where("machine_id", "=", machineId)
      .where(sql<boolean>`instance_generation::bigint < ${instanceGeneration}::bigint`)
      .orderBy(sql`instance_generation::bigint`, "desc")
      .limit(1)
      .executeTakeFirst();
    const moved = await this.db
      .updateTable("device_instance_bindings")
      .set({ machine_id: machineId, previous_generation: previous?.instance_generation ?? null })
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", instanceGeneration)
      .where("binding_id", "=", bindingId)
      .where("status", "=", "awaiting-device")
      .executeTakeFirst();
    if (!moved.numUpdatedRows)
      throw new InstanceBindingError("The binding changed before it could follow the new machine");
  }

  private async activeMachine(deviceId: string): Promise<string> {
    const machine = await this.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!machine) throw new InstanceBindingError("The device has no active machine to bind");
    return machine.id;
  }

  /**
   * Under the device authority writer: the answer must be for the exact committed generation and
   * binding of the current row, from the machine the request went to. A different environment
   * fingerprint than the previous installed generation resets Full consent; the first verified
   * proof of an unprobed device does not (its semantic scope was what the person consented to).
   */
  @Transactional()
  async install(
    deviceId: string,
    machineId: string,
    committed: CommittedBinding,
    answer: BindInstanceResultV3,
    /** The authenticated connection the answer came on (recorded with its owner report). */
    connectionId: string | null = null,
  ): Promise<void> {
    const subject = { orgId: committed.orgId, deviceId };
    await this.ceilings.lock(subject, "device");
    const { request } = committed;
    const identity = runtimeIdentity(answer.runtimeIdentity);
    if (
      answer.bindingId !== request.bindingId ||
      answer.instanceGeneration !== request.instanceGeneration ||
      answer.instanceId !== request.instanceId ||
      identity.instanceGeneration !== request.instanceGeneration
    )
      throw new DeviceProtocolError("Binding answer belongs to another instance generation");
    const instance = await this.db
      .selectFrom("device_instances")
      .select(["provider", "created_at", "handle", "status"])
      .where("device_id", "=", deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !instance ||
      instance.provider !== LOCAL_PROVIDER ||
      String(instance.created_at.getTime()) !== request.instanceGeneration ||
      instance.handle?.id !== request.instanceId ||
      !["running", "suspended"].includes(instance.status)
    )
      throw new InstanceBindingError("The instance was replaced before its binding completed");
    const binding = await this.db
      .selectFrom("device_instance_bindings")
      .select(["binding_id", "status", "runtime_identity"])
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", request.instanceGeneration)
      .forUpdate()
      .executeTakeFirst();
    if (!binding || binding.binding_id !== request.bindingId)
      throw new InstanceBindingError("The binding id does not match the committed binding");
    const machine = await this.db
      .selectFrom("device_machines")
      .select(["id", "program_version"])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (machine?.id !== machineId)
      throw new InstanceBindingError("The device's machine changed before its binding completed");
    if (!machine.program_version)
      throw new InstanceBindingError("The machine has not reported its program version");
    if (binding.status === "installed") return;
    // B2: the answer's authenticated owner report enters the common owner writer; a lower
    // sequence is ignored there and a conflicting one blocks new authority, neither failing the
    // installation
    await this.owners.recordLocked(machineId, answer.ownerCeiling, {
      connectionId,
      via: "bind",
    });
    // the environment this device last proved, whichever generation that was: the chain's
    // previous may be a binding whose answer never arrived (never installed)
    const previous = await this.db
      .selectFrom("device_instance_bindings")
      .select("runtime_identity")
      .where("device_id", "=", deviceId)
      .where("status", "=", "installed")
      .where(sql<boolean>`instance_generation::bigint < ${request.instanceGeneration}::bigint`)
      .orderBy(sql`instance_generation::bigint`, "desc")
      .limit(1)
      .executeTakeFirst();
    if (
      previous?.runtime_identity &&
      previous.runtime_identity.imageFingerprint !== identity.imageFingerprint
    )
      await this.ceilings.publishLocked(subject, "device", true, true);
    await this.db
      .updateTable("device_instance_bindings")
      .set({
        status: "installed",
        machine_id: machineId,
        runtime_identity: JSON.stringify(identity),
        installed_at: sql`now()`,
      })
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", request.instanceGeneration)
      .where("binding_id", "=", request.bindingId)
      .execute();
    await this.reports.record(
      deviceId,
      LOCAL_PROVIDER,
      machine.program_version,
      identity,
      answer.permissionSupport,
    );
  }
}
