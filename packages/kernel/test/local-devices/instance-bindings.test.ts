import { randomUUID } from "node:crypto";
import { type BindInstanceResultV3, DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { createLogger } from "../../src/log.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import {
  InconsistentGenerationError,
  PermissionInstanceWrites,
} from "../../src/sandbox/permission-instance-writes.js";
import {
  PermissionRuntimeReports,
  readRuntimeReport,
} from "../../src/sandbox/permission-runtime-reports.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { stagedHello as fakeHello } from "./fake-machine.js";

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.device_generation_high_water, capybara.device_instance_bindings, capybara.device_permission_reports",
  );
});

const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/Users/owner/capybara" };
const support = {
  version: 1 as const,
  restricted: null,
  fullAccess: true,
  background: true,
  unavailableReason: "Restricted per-instance validation pending",
};
const identityFor = (
  instanceGeneration: string,
  overrides: Partial<Record<string, string>> = {},
) => ({
  runtimeHash: "a".repeat(64),
  helperHash: "b".repeat(64),
  imageFingerprint: "c".repeat(64),
  instanceGeneration,
  ...overrides,
});

/** A bound hello from the same machine (its roots) re-reporting what it verified. */
const stagedHello = (identity?: ReturnType<typeof identityFor>) => ({
  ...fakeHello(identity),
  roots: ROOTS,
  permissionSupport: support,
});

async function localDevice() {
  const seed = await seedConversation(raw),
    db = kernelDb(raw),
    deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: seed.orgId,
      owner_kind: "personal",
      owner_account_id: seed.accountId,
      source: "local",
      provider: "@local",
      name: "Laptop",
    })
    .execute();
  const machine = await db
    .insertInto("device_machines")
    .values({
      org_id: seed.orgId,
      device_id: deviceId,
      account_id: seed.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "linux",
      arch: "x64",
      program_version: "0.1.0",
      roots: JSON.stringify(ROOTS),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("device_instances")
    .values({ device_id: deviceId, org_id: seed.orgId, provider: "@local", status: "creating" })
    .execute();
  let fence = 0;
  const create = async (roots = ROOTS) => {
    const at = await k.app.get(PermissionInstanceWrites).commitHandle(
      seed.orgId,
      deviceId,
      fence,
      roots,
      {
        status: "running",
        handle: JSON.stringify({ id: deviceId, roots }),
        had_instance: true,
      },
      new AbortController().signal,
    );
    fence++;
    return String(at.getTime());
  };
  const fullRevision = async () =>
    (await db
      .selectFrom("permission_authority_epochs")
      .select(["revision", "full_revision"])
      .where("kind", "=", "device")
      .where("id", "=", deviceId)
      .executeTakeFirst()) ?? { revision: 0, full_revision: 0 };
  const binding = (generation: string) =>
    db
      .selectFrom("device_instance_bindings")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("instance_generation", "=", generation)
      .executeTakeFirst();
  const report = () => readRuntimeReport(db, deviceId, "@local", "0.1.0");
  return {
    ...seed,
    db,
    deviceId,
    machineId: machine.id,
    create,
    fullRevision,
    binding,
    report,
    setFence: (n: number) => {
      fence = n;
    },
  };
}

/** The relay answers bindInstance as an authenticated device that verified `identity`. */
function deviceAnswers(identity?: (generation: string) => ReturnType<typeof identityFor>) {
  const relay = k.app.get(LocalDeviceRelay);
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(relay, "connection").mockResolvedValue({ connectionId: "c1", maxFrameBytes: 69632 });
  vi.spyOn(relay, "callV3").mockImplementation(async (_d, op, args) => {
    expect(op).toBe("bindInstance");
    sent.push(args);
    const g = args.instanceGeneration as string;
    return {
      instanceId: args.instanceId as string,
      instanceGeneration: g,
      bindingId: args.bindingId as string,
      runtimeIdentity: identity ? identity(g) : identityFor(g),
      permissionSupport: support,
      ownerCeiling: {
        version: 2,
        sequence: 1,
        revision: "owner-1",
        fullAccess: true,
        restrictedProjectReach: "workspace",
        restrictedAllowedDomains: [],
      },
    } satisfies Omit<BindInstanceResultV3, "permissionSupport"> & { permissionSupport: unknown };
  });
  return sent;
}

it("never reuses a generation across a rolled-back clock or a deleted instance row", async () => {
  const f = await localDevice();
  const future = Date.now() + 3_600_000;
  // an earlier instance generation recorded while the database clock ran an hour ahead
  await f.db
    .insertInto("device_permission_reports")
    .values({
      device_id: f.deviceId,
      provider: "@local",
      provider_version: "0.1.0",
      instance_generation: String(future),
      identity_hash: "x",
      report: JSON.stringify(support),
    })
    .execute();
  const first = await f.create();
  expect(Number(first)).toBeGreaterThan(future);
  // the instance row is deleted and made again: the mark outlives it
  await f.db.deleteFrom("device_instances").where("device_id", "=", f.deviceId).execute();
  await f.db
    .insertInto("device_instances")
    .values({ device_id: f.deviceId, org_id: f.orgId, provider: "@local", status: "creating" })
    .execute();
  f.setFence(0);
  const second = await f.create();
  expect(Number(second)).toBeGreaterThan(Number(first));
  expect((await f.binding(first))?.binding_id).not.toBe((await f.binding(second))?.binding_id);
});

it("serializes creates within one database millisecond to consecutive generations", async () => {
  const f = await localDevice();
  const writes = k.app.get(PermissionInstanceWrites);
  const now = Date.now();
  vi.spyOn(
    writes as unknown as { databaseNowMs(): Promise<number> },
    "databaseNowMs",
  ).mockResolvedValue(now);
  const a = await f.create();
  const b = await f.create();
  expect([Number(a), Number(b)]).toEqual([now, now + 1]);
  expect((await f.binding(b))?.previous_generation).toBeNull();
});

it("refuses an unordered prior generation instead of guessing a high-water mark", async () => {
  const f = await localDevice();
  await f.db
    .insertInto("device_permission_reports")
    .values({
      device_id: f.deviceId,
      provider: "@local",
      provider_version: "0.1.0",
      instance_generation: "test-instance-1",
      identity_hash: "x",
      report: JSON.stringify(support),
    })
    .execute();
  await expect(f.create()).rejects.toBeInstanceOf(InconsistentGenerationError);
  const row = await f.db
    .selectFrom("device_instances")
    .select(["status", "generation"])
    .where("device_id", "=", f.deviceId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ status: "creating", generation: 0 });
});

it("an awaiting binding attests nothing; only the post-commit bind installs the report", async () => {
  const f = await localDevice();
  const before = await f.fullRevision();
  const g = await f.create();
  // the first create landed on the roots the person saw: no Full consent reset
  expect((await f.fullRevision()).full_revision).toBe(before.full_revision);
  expect(await f.binding(g)).toMatchObject({
    status: "awaiting-device",
    previous_generation: null,
  });
  // a report recorded for this generation without the binding stays unprobed
  const reports = k.app.get(PermissionRuntimeReports);
  await k.app.get(TransactionHost).run(async () => {
    await k.app.get(PermissionCeilingWrites).lock(f, "device");
    await reports.record(f.deviceId, "@local", "0.1.0", identityFor(g), support);
  });
  expect((await f.report()).state).toBe("unprobed");
  // a bound hello cannot finish an awaiting installation either
  await k.app.get(MachinesService).recordHelloV3(f.machineId, stagedHello(identityFor(g)));
  expect((await f.report()).state).toBe("unprobed");

  const sent = deviceAnswers();
  const answer = await k.app.get(LocalInstanceBindings).bind(f.deviceId, AbortSignal.timeout(5000));
  expect(sent).toEqual([
    {
      instanceId: f.deviceId,
      instanceGeneration: g,
      bindingId: (await f.binding(g))?.binding_id,
      expectedPreviousGeneration: null,
    },
  ]);
  expect(answer?.instanceGeneration).toBe(g);
  expect(await f.binding(g)).toMatchObject({ status: "installed", machine_id: f.machineId });
  expect(await f.report()).toEqual({ state: "supported", report: support });
  // the first verified proof keeps the consent the person gave while it was unprobed
  expect((await f.fullRevision()).full_revision).toBe(before.full_revision);
  // a retry of an installed binding sends nothing
  expect(await k.app.get(LocalInstanceBindings).bind(f.deviceId, AbortSignal.timeout(5000))).toBe(
    null,
  );
  expect(sent).toHaveLength(1);
});

it("a first create on other roots than the person saw resets Full consent", async () => {
  const f = await localDevice();
  const before = await f.fullRevision();
  await f.create({ ...ROOTS, workspace: "/elsewhere" });
  expect((await f.fullRevision()).full_revision).toBe(before.full_revision + 1);
});

it("a delayed answer for a replaced generation cannot populate the replacement", async () => {
  const f = await localDevice();
  const old = await f.create();
  const committedOld = await k.app.get(LocalInstanceBindings).committed(f.deviceId);
  const replacement = await f.create();
  expect(Number(replacement)).toBeGreaterThan(Number(old));
  const bindings = k.app.get(LocalInstanceBindings);
  if (!committedOld) throw new Error("expected the old committed binding");
  await expect(
    bindings.install(f.deviceId, f.machineId, committedOld, {
      ...committedOld.request,
      runtimeIdentity: identityFor(old),
      permissionSupport: support,
      ownerCeiling: {
        version: 2,
        sequence: 1,
        revision: "owner-1",
        fullAccess: true,
        restrictedProjectReach: "workspace",
        restrictedAllowedDomains: [],
      },
    }),
  ).rejects.toThrow("replaced");
  expect((await f.binding(old))?.status).toBe("awaiting-device");
  expect((await f.binding(replacement))?.status).toBe("awaiting-device");
  expect((await f.report()).state).toBe("unprobed");
  // a reply for the replacement that carries the old binding id is refused too
  const current = await bindings.committed(f.deviceId);
  if (!current) throw new Error("expected the replacement binding");
  await expect(
    bindings.install(
      f.deviceId,
      f.machineId,
      {
        ...current,
        request: { ...current.request, bindingId: committedOld.request.bindingId },
      },
      {
        ...current.request,
        bindingId: committedOld.request.bindingId,
        runtimeIdentity: identityFor(replacement),
        permissionSupport: support,
        ownerCeiling: {
          version: 2,
          sequence: 1,
          revision: "owner-1",
          fullAccess: true,
          restrictedProjectReach: "workspace",
          restrictedAllowedDomains: [],
        },
      },
    ),
  ).rejects.toThrow("binding id");
  // the real replacement binds and names the generation it follows only once one was installed
  deviceAnswers();
  await bindings.bind(f.deviceId, AbortSignal.timeout(5000));
  expect((await f.binding(replacement))?.status).toBe("installed");
  expect((await f.report()).state).toBe("supported");
});

it("bound hellos re-report only the installed identity; a changed one stops admission", async () => {
  const f = await localDevice();
  const g = await f.create();
  deviceAnswers();
  await k.app.get(LocalInstanceBindings).bind(f.deviceId, AbortSignal.timeout(5000));
  const machines = k.app.get(MachinesService);
  const base = await f.fullRevision();
  // reconnect / restart / machine rename under the same authority: consent and report kept
  await f.db
    .updateTable("device_machines")
    .set({ name: "Renamed laptop" })
    .where("id", "=", f.machineId)
    .execute();
  await machines.recordHelloV3(f.machineId, stagedHello(identityFor(g)));
  expect((await f.report()).state).toBe("supported");
  expect(await f.fullRevision()).toEqual(base);
  // an unbound hello (a process that lost its binding) attests nothing
  const unbound = {
    ...fakeHello(),
    roots: ROOTS,
    instanceGeneration: null,
    permissionSupport: {
      version: 1 as const,
      restricted: null,
      fullAccess: false,
      background: false,
      unavailableReason: "Instance is not bound yet",
    },
  };
  await machines.recordHelloV3(f.machineId, unbound);
  expect((await f.report()).state).toBe("unprobed");
  await machines.recordHelloV3(f.machineId, stagedHello(identityFor(g)));
  expect((await f.report()).state).toBe("supported");
  // a changed helper under the same binding: report invalid, admissions fenced, consent kept
  await machines.recordHelloV3(
    f.machineId,
    stagedHello(identityFor(g, { helperHash: "d".repeat(64) })),
  );
  expect((await f.report()).state).toBe("unprobed");
  const afterHelper = await f.fullRevision();
  expect(afterHelper.revision).toBeGreaterThan(base.revision);
  expect(afterHelper.full_revision).toBe(base.full_revision);
  // the verified identity is back: supported again without another reset
  await machines.recordHelloV3(f.machineId, stagedHello(identityFor(g)));
  expect((await f.report()).state).toBe("supported");
  // a changed environment (interpreter, OS, boundary) resets Full consent
  await machines.recordHelloV3(
    f.machineId,
    stagedHello(identityFor(g, { imageFingerprint: "e".repeat(64) })),
  );
  expect((await f.report()).state).toBe("unprobed");
  expect((await f.fullRevision()).full_revision).toBe(base.full_revision + 1);
  // a hello asserting another generation never attests this instance
  await machines.recordHelloV3(f.machineId, stagedHello(identityFor(String(Number(g) + 5))));
  expect((await f.report()).state).toBe("unprobed");
});

it("a replacement with a changed environment resets Full consent; the same one keeps it", async () => {
  const f = await localDevice();
  const bindings = k.app.get(LocalInstanceBindings);
  const g1 = await f.create();
  deviceAnswers();
  await bindings.bind(f.deviceId, AbortSignal.timeout(5000));
  const base = await f.fullRevision();
  const g2 = await f.create();
  expect((await f.binding(g2))?.previous_generation).toBe(g1);
  vi.restoreAllMocks();
  const sent = deviceAnswers();
  await bindings.bind(f.deviceId, AbortSignal.timeout(5000));
  expect(sent[0]?.expectedPreviousGeneration).toBe(g1);
  expect((await f.fullRevision()).full_revision).toBe(base.full_revision);
  const g3 = await f.create();
  vi.restoreAllMocks();
  deviceAnswers((g) => identityFor(g, { imageFingerprint: "f".repeat(64) }));
  await bindings.bind(f.deviceId, AbortSignal.timeout(5000));
  expect((await f.binding(g3))?.status).toBe("installed");
  expect((await f.fullRevision()).full_revision).toBe(base.full_revision + 1);
});

it("a new machine credential is never asked to confirm another machine's binding", async () => {
  const f = await localDevice();
  const bindings = k.app.get(LocalInstanceBindings);
  await f.create();
  deviceAnswers();
  await bindings.bind(f.deviceId, AbortSignal.timeout(5000));
  await f.db
    .updateTable("device_machines")
    .set({ revoked_at: new Date() })
    .where("id", "=", f.machineId)
    .execute();
  await f.db
    .insertInto("device_machines")
    .values({
      org_id: f.orgId,
      device_id: f.deviceId,
      account_id: f.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "linux",
      arch: "x64",
      program_version: "0.1.0",
      roots: JSON.stringify(ROOTS),
    })
    .execute();
  const g = await f.create();
  expect((await f.binding(g))?.previous_generation).toBeNull();
});
