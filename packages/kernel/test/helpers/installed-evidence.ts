import {
  DEFAULT_SANDBOX_ROOTS,
  rootsOf,
  type SandboxPermissionSupport,
  type SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import type { Kysely } from "kysely";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import type { AppliedLimits } from "../../src/sandbox/modes.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { PermissionRuntimeReports } from "../../src/sandbox/permission-runtime-reports.js";
import type { TestKernel } from "./runs.js";

/** A runtime report supporting both the restricted profiles and Full access. */
export const SUPPORTS_BOTH: SandboxPermissionSupport = {
  version: 1,
  restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
  fullAccess: true,
  background: false,
};

/**
 * Seeds what admission and the recorded permission context need to prove a device's installed
 * environment (B-16): the instance's committed roots, a runtime report of its generation and, for
 * a local device, an installed binding of that generation on the device's active machine. Without
 * it both refuse with the same unprobed reason. The device and its instance row already exist.
 */
export async function seedInstalledEvidence(
  k: TestKernel,
  raw: Kysely<unknown>,
  input: {
    orgId: string;
    deviceId: string;
    provider: string;
    version: string;
    report?: SandboxPermissionSupport;
  },
): Promise<{ generation: string; bindingId: string | null }> {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const db = kernelDb(raw as Kysely<any>);
  const instance = await db
    .selectFrom("device_instances")
    .select(["created_at", "handle"])
    .where("device_id", "=", input.deviceId)
    .executeTakeFirstOrThrow();
  const device = await db
    .selectFrom("devices")
    .select("source")
    .where("id", "=", input.deviceId)
    .executeTakeFirstOrThrow();
  const generation = String(instance.created_at.getTime());
  const roots = (instance.handle as { roots?: SandboxRoots } | null)?.roots;
  if (!roots) throw new Error("The device instance needs a handle with roots");
  await db
    .updateTable("device_instances")
    .set({ permission_roots: JSON.stringify(roots) })
    .where("device_id", "=", input.deviceId)
    .execute();
  // a cloud device records the kernel-built cloud identity its row proves, as the lifecycle does
  if (device.source !== "local") {
    await seedCloudEvidence(k, input);
    return { generation, bindingId: null };
  }
  const identity = {
    runtimeHash: "a".repeat(64),
    helperHash: "b".repeat(64),
    imageFingerprint: "c".repeat(64),
    instanceGeneration: generation,
  };
  await k.app.get(TransactionHost).run(async () => {
    await k.app
      .get(PermissionAuthorityLock)
      .acquire(
        { orgId: input.orgId, deviceId: input.deviceId },
        { kind: "write", level: "device" },
      );
    await k.app
      .get(PermissionRuntimeReports)
      .record(
        input.deviceId,
        input.provider,
        input.version,
        identity,
        input.report ?? SUPPORTS_BOTH,
      );
  });
  const machine = await db
    .selectFrom("device_machines")
    .select("id")
    .where("device_id", "=", input.deviceId)
    .where("revoked_at", "is", null)
    .executeTakeFirstOrThrow();
  const bindingId = crypto.randomUUID();
  await db
    .insertInto("device_instance_bindings")
    .values({
      device_id: input.deviceId,
      instance_generation: generation,
      binding_id: bindingId,
      provider: input.provider,
      status: "installed",
      machine_id: machine.id,
      runtime_identity: JSON.stringify(identity),
    })
    .onConflict((oc) =>
      oc.columns(["device_id", "instance_generation"]).doUpdateSet({
        binding_id: bindingId,
        provider: input.provider,
        status: "installed",
        machine_id: machine.id,
        runtime_identity: JSON.stringify(identity),
      }),
    )
    .execute();
  return { generation, bindingId };
}

/**
 * Records a cloud device's current instance evidence (B-15) the way the lifecycle does after create
 * or resume: the provider's support report with the kernel-built identity of the committed row
 * (its handle, generation and recorded applied limits). The instance row already exists.
 */
export async function seedCloudEvidence(
  k: TestKernel,
  input: {
    orgId: string;
    deviceId: string;
    provider: string;
    version: string;
    report?: SandboxPermissionSupport;
  },
): Promise<void> {
  await k.app.get(TransactionHost).run(async () => {
    await k.app
      .get(PermissionAuthorityLock)
      .acquire(
        { orgId: input.orgId, deviceId: input.deviceId },
        { kind: "write", level: "device" },
      );
    // the roots `commitHandle` commits with the handle
    const db = k.app.get(KernelDb);
    const instance = await db
      .selectFrom("device_instances")
      .select("handle")
      .where("device_id", "=", input.deviceId)
      .executeTakeFirstOrThrow();
    if (!instance.handle) throw new Error("The cloud instance needs a handle");
    await db
      .updateTable("device_instances")
      .set({ permission_roots: JSON.stringify(rootsOf(instance.handle)) })
      .where("device_id", "=", input.deviceId)
      .execute();
    await k.app
      .get(PermissionRuntimeReports)
      .recordCloud(input.deviceId, input.provider, input.version, input.report ?? SUPPORTS_BOTH);
  });
}

/**
 * Provisions a cloud device's instance as the lifecycle's create does (B-15): a running instance
 * on the default roots whose recorded applied limits are `applied` (default: what the device's
 * effective policy wants now), then its cloud evidence. Replaces any instance row it had.
 */
export async function seedCloudInstance(
  k: TestKernel,
  input: {
    orgId: string;
    deviceId: string;
    provider: string;
    version: string;
    applied?: AppliedLimits;
    report?: SandboxPermissionSupport;
  },
): Promise<void> {
  const db = k.app.get(KernelDb);
  const policy = await k.app
    .get(PermissionFacts)
    .devicePolicy({ orgId: input.orgId, deviceId: input.deviceId });
  const applied = input.applied ?? {
    mode: policy.mode,
    network: { kind: policy.network.kind, hosts: [...policy.network.hosts] },
  };
  const row = {
    org_id: input.orgId,
    provider: input.provider,
    status: "running" as const,
    handle: JSON.stringify({ id: input.deviceId, roots: DEFAULT_SANDBOX_ROOTS }),
    permission_roots: JSON.stringify(DEFAULT_SANDBOX_ROOTS),
    fs_status: "ready" as const,
    fs_handle: JSON.stringify({ id: `fs-${input.deviceId}` }),
    had_instance: true,
    instance_limits: JSON.stringify(applied),
  };
  await db
    .insertInto("device_instances")
    .values({ device_id: input.deviceId, ...row })
    .onConflict((oc) => oc.column("device_id").doUpdateSet(row))
    .execute();
  await seedCloudEvidence(k, input);
}
