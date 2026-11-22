import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DeviceProvider,
  ExtensionPermissionError,
  isDeviceOfflineError,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import {
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DEVICE_CLOSE, MAX_EVENTS_IN_FLIGHT } from "../../src/dial-in/gateway.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { DialInRelay } from "../../src/dial-in/relay.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { DeviceReports } from "../../src/sandbox/device-reports.js";
import {
  PermissionAdmissionStale,
  SandboxOperationIntents,
} from "../../src/sandbox/operation-intents.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { permissionScopeHash } from "../../src/sandbox/permission-facts.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import {
  FAKE_INSTANCE_PERMISSION_SUPPORT,
  setFakeReportRevision,
  setFakeSandboxPermissionSupport,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { SUPPORTS_BOTH, seedInstalledEvidence } from "../helpers/installed-evidence.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createOrg,
  enableExtensions,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";

/**
 * The generic dial-in channel (device provider spec §5): `GET /device/connect` routes a machine
 * credential to the provider of its device (`permissions.dialIn`), the gateway speaks the envelope
 * and hands the bodies to the provider's `dialIn` handler, and the provider talks to its own
 * machines only through `ctx.dialIn` and tells the kernel about its devices through
 * `ctx.devices`. Driven with the `fake-dial-in` fixture provider and `FakeDialInMachine`; the
 * report revision tests also drive the instance-boundary cloud fixture `device-fake`.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

const GRACE_SECONDS = 2;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let ownerId: string;
let orgId: string;
let url: string;
/** `device-fake`'s deployment root. */
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  root = await mkdtemp(join(tmpdir(), "cap-dial-in-routing-"));
  // an optional preinstall: loaded on the deployment, on only in the orgs that switch it on
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        devices: { maxPersonal: 50, local: { reconnectGraceSeconds: GRACE_SECONDS } },
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "device-fake": { root } },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  await enableExtensions(raw, orgId, "fake-dial-in");
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

/** A device row of `provider` owned by the owner (for a provider that takes no machines). */
async function insertDevice(provider: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, name, provider)
    VALUES (${id}, ${orgId}, 'personal', ${ownerId}, ${`Box ${id.slice(0, 8)}`}, ${provider})`.execute(
    raw,
  );
  return id;
}

/**
 * A device of `provider` with a signed-in machine (the machine row issued directly: signing in by
 * provider is the sign-in's own task, `auth.test.ts`).
 */
async function device(provider = "fake-dial-in", stored?: string) {
  // `stored`: a device row of that provider, written directly (no dial-in provider of that name)
  const deviceId =
    stored === undefined
      ? (
          await k.app
            .get(TransactionHost)
            .run(() =>
              k.app
                .get(DevicesService)
                .createDialIn(orgId, ownerId, provider, `Box ${randomUUID().slice(0, 8)}`),
            )
        ).id
      : await insertDevice(stored);
  const issued = await k.app.get(TransactionHost).run(() =>
    k.app.get(DialInMachines).issue({
      orgId,
      deviceId,
      accountId: ownerId,
      name: "fake",
      os: "linux",
      arch: "x64",
      programVersion: "0.0.0",
    }),
  );
  return { deviceId, ...issued };
}

/** What the fixture keeps in its `ctx.kv` (`cap:fake-dial-in:kv:<key>`). */
const kv = (key: string) => redis.get(`cap:fake-dial-in:kv:${key}`);

const provider = (): DeviceProvider => {
  const impl = k.app.get(DeviceProviders).forDevice("fake-dial-in")?.impl;
  if (!impl) throw new Error("fake-dial-in is not loaded");
  return impl;
};

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("GET /device/connect routes by the device's provider", () => {
  it("routes a credential to its device provider and opens the socket", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1", outsideSandbox: false },
    });
    expect(machine.connectionId).toEqual(expect.any(String));
    // ready carries the effective capacity: the 1 MiB announced, under the kernel's 16 MiB default
    expect(machine.maxFrameBytes).toBe(1024 * 1024);
    // the provider accepted the body; the kernel recorded the envelope's program facts
    expect(JSON.parse((await kv(`hello:${d.deviceId}`)) ?? "{}")).toEqual({
      revision: "r1",
      outsideSandbox: false,
    });
    expect(
      await db
        .selectFrom("device_machines")
        .select(["program_version", "os", "arch"])
        .where("id", "=", d.machineId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ program_version: "0.0.0-fake", os: "linux", arch: "x64" });
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(true);
    await machine.close();
  });

  it("answers 426 when the protocol header differs from the provider's declaration", async () => {
    const d = await device();
    const e = (await rejection(
      FakeDialInMachine.connect({
        url,
        credential: d.credential,
        protocol: "capybara-device/5",
        hello: {},
      }),
    )) as Error;
    expect(e.message).toContain("HTTP 426");
    expect(e.message).toContain("device.program_outdated");
    expect(e.message).toContain(FAKE_DIAL_IN_PROTOCOL);
  });

  it("answers 403 device.provider_unavailable when the device's provider is off in the org", async () => {
    const d = await device();
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE plugin = 'fake-dial-in' AND org_id = ${orgId}`.execute(raw);
    try {
      const e = (await rejection(
        FakeDialInMachine.connect({ url, credential: d.credential, hello: {} }),
      )) as Error;
      expect(e.message).toContain("HTTP 403");
      expect(e.message).toContain("device.provider_unavailable");
    } finally {
      await enableExtensions(raw, orgId, "fake-dial-in");
    }
  });

  it("closes 4400 with the provider's code when onHello refuses, without claiming the lease", async () => {
    const d = await device();
    const e = (await rejection(
      FakeDialInMachine.connect({ url, credential: d.credential, hello: { refuse: "nope" } }),
    )) as Error;
    expect(e.message).toContain(`closed before ready: ${DEVICE_CLOSE.protocol}`);
    expect(e.message).toContain("fake.refused: nope");
    expect(await kv(`hello:${d.deviceId}`)).toBeNull();
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(false);
  });

  it("closes 4400 on a frame over maxFrameBytes without calling onFrame", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
      maxFrameBytes: 2048,
    });
    expect(machine.maxFrameBytes).toBe(2048);
    // within the negotiated capacity: handed to the provider
    await machine.send({ revision: "r2" });
    await waitFor(() => kv(`frame:${d.deviceId}`));
    await redis.del(`cap:fake-dial-in:kv:frame:${d.deviceId}`);
    // over the 2048 bytes the machine announced (below the kernel's own limit): closed, unread
    await machine.send({ revision: "x".repeat(3000) });
    expect((await machine.closed).code).toBe(DEVICE_CLOSE.protocol);
    expect(await kv(`frame:${d.deviceId}`)).toBeNull();
  });

  it("onClose receives replaced when a newer connection of the same credential takes over", async () => {
    const d = await device();
    const first = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    const second = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    expect((await first.closed).code).toBe(DEVICE_CLOSE.replaced);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "replaced" ? true : null));
    // the machine revoked as its device is deleted: the provider learns why
    await k.app
      .get(TransactionHost)
      .run(() => k.app.get(DialInMachines).revokeActive(d.deviceId, "deleted"));
    const deleted = await second.closed;
    expect(deleted.code).toBe(DEVICE_CLOSE.revoked);
    expect(deleted.reason).toBe("the device was deleted");
    expect(second.stops).toEqual(["stop"]);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "deleted" ? true : null));
  });
  it("onClose receives replaced when the device signs in from another machine", async () => {
    const d = await device();
    const first = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // a second sign-in into the same device: a new machine credential, the first one revoked
    const second = await k.app.get(TransactionHost).run(() =>
      k.app.get(DialInMachines).issue({
        orgId,
        deviceId: d.deviceId,
        accountId: ownerId,
        name: "other",
        os: "linux",
        arch: "x64",
        programVersion: "0.0.0",
      }),
    );
    expect((await first.closed).code).toBe(DEVICE_CLOSE.replaced);
    // no stop reaches the replaced machine (it could reach the replacement instead)
    expect(first.stops).toEqual([]);
    await waitFor(async () => ((await kv(`closed:${d.deviceId}`)) === "replaced" ? true : null));
    const next = await FakeDialInMachine.connect({
      url,
      credential: second.credential,
      hello: { revision: "r2" },
    });
    expect(await k.app.get(DialInRelay).online(d.deviceId)).toBe(true);
    await next.close();
  });

  it("closes 4400 when a machine has more events in flight than the gateway keeps", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // the provider never finishes the first event: the rest wait, up to the cap
    await machine.send({ hang: true });
    for (let i = 0; i < MAX_EVENTS_IN_FLIGHT; i++) {
      if ((await Promise.race([machine.closed, Promise.resolve(null)])) !== null) break;
      await machine.send({ revision: `r${i}` }).catch(() => {});
    }
    const closed = await machine.closed;
    expect(closed.code).toBe(DEVICE_CLOSE.protocol);
    expect(closed.reason).toContain("too many events in flight");
  });
});

describe("ctx.dialIn", () => {
  it("ctx.dialIn.request relays a body and resolves the machine's res body", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    machine.onRequest((body) =>
      (body as { op?: string }).op === "stat" ? { size: 7, isDir: false } : null,
    );
    expect(await provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(10_000))).toEqual({
      size: 7,
      isDir: false,
    });
    expect(machine.requests).toEqual([{ op: "stat", args: { path: "/w/a" } }]);
    await machine.close();
  });

  it("ctx.dialIn.request throws DeviceOfflineError after the reconnect grace with no holder", async () => {
    const d = await device();
    const machine = await FakeDialInMachine.connect({
      url,
      credential: d.credential,
      hello: { revision: "r1" },
    });
    // the machine takes the request and goes away without answering
    machine.onRequest(() => new Promise(() => {}));
    const t0 = Date.now();
    const pending = rejection(
      provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(60_000)),
    );
    await waitFor(async () => (machine.requests.length > 0 ? true : null));
    await machine.close();
    const e = await pending;
    expect(isDeviceOfflineError(e)).toBe(true);
    // one lease check (at most a poll) plus the grace, far from the request's own deadline
    expect(Date.now() - t0).toBeLessThan(5000 + GRACE_SECONDS * 1000 + 5000);
  });

  it("ctx.dialIn.request for its own device is refused while the provider is off in the org", async () => {
    const d = await device();
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE plugin = 'fake-dial-in' AND org_id = ${orgId}`.execute(raw);
    try {
      const e = await rejection(
        provider().stat({ id: d.deviceId }, "/w/a", AbortSignal.timeout(10_000)),
      );
      expect(e).toBeInstanceOf(ExtensionPermissionError);
      expect((e as Error).message).toBe(`device ${d.deviceId} is not served by fake-dial-in`);
    } finally {
      await enableExtensions(raw, orgId, "fake-dial-in");
    }
  });

  it("ctx.dialIn.request for a device of another provider throws ExtensionPermissionError", async () => {
    const other = await device(undefined, "device-fake");
    const e = await rejection(
      provider().stat({ id: other.deviceId }, "/w/a", AbortSignal.timeout(10_000)),
    );
    expect(e).toBeInstanceOf(ExtensionPermissionError);
    expect((e as Error).message).toBe(`device ${other.deviceId} is not served by fake-dial-in`);
    expect(await redis.exists(`capk:device-req:${other.deviceId}`)).toBe(0);
  });
});

/**
 * Report revisions drive the provider-neutral device authority epoch (device-provider spec §6.7,
 * index Review Focus): a revision a provider reports between an approval being asked and being
 * granted moves the epoch the approval is bound to, for an instance-boundary cloud provider
 * (`device-fake`) as well as a dial-in one (`fake-dial-in`, whose machine's hello and event frames
 * make the fixture call `ctx.devices.reportChanged` itself).
 */
describe("ctx.devices.reportChanged and the device authority epoch", () => {
  /**
   * The authority revision an approval asked now is bound to: its `authorityRevision` hashes the
   * epoch vector read under the admission lock, and issuing the grant and admitting the call
   * compare it again.
   */
  const askedUnder = (deviceId: string): Promise<string> =>
    k.app.get(TransactionHost).run(async () => {
      const subject = { orgId, deviceId };
      await k.app.get(PermissionAuthorityLock).acquire(subject, { kind: "admit" });
      return permissionScopeHash(
        await k.app.get(PermissionAuthorityEpochStore).readLocked(subject),
      );
    });

  const fullRevision = async (deviceId: string): Promise<number> =>
    (
      await db
        .selectFrom("permission_authority_epochs")
        .select("full_revision")
        .where("kind", "=", "device")
        .where("id", "=", deviceId)
        .executeTakeFirst()
    )?.full_revision ?? 0;

  const storedRevision = async (deviceId: string) =>
    (await k.app.get(DeviceReports).current(deviceId))?.revision ?? null;

  const reportAt = async (deviceId: string) =>
    (
      await db
        .selectFrom("devices")
        .select("report_at")
        .where("id", "=", deviceId)
        .executeTakeFirstOrThrow()
    ).report_at?.getTime() ?? 0;

  /** How each fixture's report changes: a device whose report says `revision`, then new ones. */
  interface Driver {
    device(revision: string): Promise<string>;
    /** The provider reports `revision` and tells the kernel; resolves once it is stored again. */
    report(deviceId: string, revision: string, extra?: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }

  const drivers: Record<"device-fake" | "fake-dial-in", () => Driver> = {
    // its revision changes through its seam; it tells the kernel what ctx.devices.reportChanged
    // tells (`DeviceReports.changed` for the calling provider)
    "device-fake": () => ({
      async device(revision) {
        const id = await seedDevice(raw, orgId, ownerId);
        await setFakeReportRevision(root, revision);
        expect(await k.app.get(DeviceReports).changed("device-fake", id)).toBe("same");
        return id;
      },
      async report(deviceId, revision) {
        await setFakeReportRevision(root, revision);
        await k.app.get(DeviceReports).changed("device-fake", deviceId);
      },
      async close() {
        await setFakeReportRevision(root, null);
      },
    }),
    // the machine's hello and event frames carry the revision; the provider calls
    // ctx.devices.reportChanged itself
    "fake-dial-in": () => {
      const machines = new Map<string, FakeDialInMachine>();
      return {
        async device(revision) {
          const d = await device();
          machines.set(
            d.deviceId,
            await FakeDialInMachine.connect({
              url,
              credential: d.credential,
              hello: { revision, outsideSandbox: true },
            }),
          );
          await waitFor(async () => (await storedRevision(d.deviceId)) === revision);
          return d.deviceId;
        },
        async report(deviceId, revision, extra = {}) {
          const before = await reportAt(deviceId);
          await machines.get(deviceId)?.send({ revision, ...extra });
          await waitFor(async () => (await reportAt(deviceId)) > before);
        },
        async close() {
          for (const m of machines.values()) await m.close();
        },
      };
    },
  };

  describe.each(["device-fake", "fake-dial-in"] as const)("%s", (name) => {
    it("an approval asked under one report revision is stale after reportChanged; the same revision keeps it", async () => {
      const d = drivers[name]();
      try {
        const id = await d.device("r1");
        const asked = await askedUnder(id);
        // told again with the same revision: the approval still matches
        await d.report(id, "r1");
        expect(await askedUnder(id)).toBe(asked);
        // another revision before the grant: the approval no longer matches
        await d.report(id, "r2");
        expect(await storedRevision(id)).toBe("r2");
        expect(await askedUnder(id)).not.toBe(asked);
      } finally {
        await d.close();
      }
    });
  });

  /**
   * A conversation of the owner bound to `deviceId` with a running claim and a started call, on
   * a running instance of `provider` whose installed evidence (its permission support `report`
   * with the kernel-built identity, which names the stored report revision) is recorded as the
   * lifecycle records it: what admission proves before any operation.
   */
  async function admissionOn(deviceId: string, provider: string, report: SandboxPermissionSupport) {
    const agentId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      executionId = randomUUID(),
      callId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${ownerId}, 'org', 1)`.execute(raw);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id, last_seq)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${ownerId}, ${deviceId}, 1)`.execute(raw);
    await sql`INSERT INTO capybara.runs
        (id, conversation_id, execution_id, trigger_account_id, status, agent_version, trigger_seq)
      VALUES (${runId}, ${conversationId}, ${executionId}, ${ownerId}, 'running', 1, 0)`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.conversation_events (conversation_id, run_id, seq, type, payload)
      VALUES (${conversationId}, ${runId}, 1, 'tool_call_started',
        ${JSON.stringify({ callId, toolKey: "Read" })}::jsonb)`.execute(raw);
    const roots = { workspace: "/work", skills: "/skills", tmp: "/tmp" };
    await sql`INSERT INTO capybara.device_instances
        (device_id, org_id, provider, status, handle, created_at, fs_status, had_instance,
         instance_limits)
      VALUES (${deviceId}, ${orgId}, ${provider}, 'running',
        ${JSON.stringify({ id: deviceId, roots })}::jsonb, ${new Date(1_700_000_000_000)},
        'ready', true,
        ${JSON.stringify({ mode: "auto", network: { kind: "open-public", hosts: [] } })}::jsonb)
      ON CONFLICT (device_id) DO UPDATE SET provider = EXCLUDED.provider,
        status = EXCLUDED.status, handle = EXCLUDED.handle, created_at = EXCLUDED.created_at,
        instance_limits = EXCLUDED.instance_limits`.execute(raw);
    const version = k.app.get(DeviceProviders).forDevice(provider)?.version;
    if (!version) throw new Error(`${provider} is not loaded`);
    await seedInstalledEvidence(k, raw, { orgId, deviceId, provider, version, report });
    const claim = { orgId, conversationId, rootId: conversationId, runId, executionId };
    const ctx = {
      orgId,
      deviceId,
      holderConversationId: conversationId,
      actor: { accountId: ownerId, conversationId, runId },
    };
    const intents = k.app.get(SandboxOperationIntents);
    const invocation = (ordinal: number) => ({
      claim,
      callId,
      deadlineMs: Date.now() + 30_000,
      ordinal,
    });
    return {
      pend: (ordinal: number) =>
        intents.pending(
          ctx,
          invocation(ordinal),
          { provider, providerVersion: version, generation: "1700000000000" },
          "stat",
          { path: "/work/file" },
          "holder",
          new AbortController().signal,
        ),
      admit: (ordinal: number) => intents.admit(ctx, invocation(ordinal)),
    };
  }

  // Review Focus (index): a report revision changing between an approval being asked and being
  // granted invalidates it, for an instance-boundary provider (device-fake) as for an
  // operation-boundary dial-in provider (fake-dial-in), end to end through admission
  describe.each([
    ["device-fake", FAKE_INSTANCE_PERMISSION_SUPPORT],
    ["fake-dial-in", SUPPORTS_BOTH],
  ] as const)("%s through admission", (name, support) => {
    it("an operation pending under one report revision is stale after reportChanged; the same revision admits it", async () => {
      const d = drivers[name]();
      if (name === "device-fake") await setFakeSandboxPermissionSupport(root, support);
      try {
        const id = await d.device("r1");
        const a = await admissionOn(id, name, support);
        // the provider tells r1 again now that an instance runs: its support is stored with it
        await d.report(id, "r1");
        await a.pend(0);
        // told again with the same revision: the pending admission still matches
        await d.report(id, "r1");
        expect((await a.admit(0)).state).toBe("admitted");
        // asked under r1, the provider reports r2 before it is admitted: stale, never admitted
        await a.pend(1);
        await d.report(id, "r2");
        expect(await storedRevision(id)).toBe("r2");
        await expect(a.admit(1)).rejects.toBeInstanceOf(PermissionAdmissionStale);
      } finally {
        if (name === "device-fake") await setFakeSandboxPermissionSupport(root, null);
        await d.close();
      }
    });
  });

  it("a machine that stops allowing outside-sandbox runs resets Full consent once", async () => {
    const d = drivers["fake-dial-in"]();
    try {
      const id = await d.device("r1");
      // an instance of the provider: its permission support is read with the report
      await db
        .insertInto("device_instances")
        .values({
          device_id: id,
          org_id: orgId,
          provider: "fake-dial-in",
          status: "running",
          handle: JSON.stringify({ id }),
          fs_status: "ready",
          had_instance: true,
        })
        .execute();
      await d.report(id, "r2");
      expect((await k.app.get(DeviceReports).current(id))?.support?.outsideSandbox).toBe(true);
      const full = await fullRevision(id);
      const before = await askedUnder(id);
      await d.report(id, "r3", { outsideSandbox: false });
      expect(await fullRevision(id)).toBe(full + 1);
      expect(await askedUnder(id)).not.toBe(before);
      expect((await k.app.get(DeviceReports).current(id))?.support?.outsideSandbox).toBe(false);
      // another revision that keeps it off: the epoch moves, the consent stays
      await d.report(id, "r4");
      expect(await fullRevision(id)).toBe(full + 1);
    } finally {
      await d.close();
    }
  });
});
