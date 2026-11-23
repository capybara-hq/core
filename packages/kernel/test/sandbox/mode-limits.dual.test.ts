import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createDb } from "../../src/db/pool.js";
import { SandboxLeases, SandboxLockLostError } from "../../src/sandbox/leases.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  fakeSandboxMeta,
  holdNextFakeSandboxUpdate,
  readFakeSandboxLimits,
  readFakeSandboxOps,
  releaseFakeSandboxUpdate,
  setFakeSandboxDelays,
} from "../fixtures/plugins/device-fake/index.js";
import { managedUseOn } from "../helpers/managed-calls.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { enableFakeProvider } from "../helpers/sandbox.js";

/**
 * Two kernel replicas (two kernels in one process sharing PG, Redis and the fake provider's root)
 * and a device whose effective mode changes (auto mode spec §4.2, §4.3): the org's `fullAccess` is
 * read from PG at each use, and the replicas using the device at once apply it exactly once, under
 * the exclusive lease; the other waits and then uses the updated instance.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
const kernels: TestKernel[] = [];
let raw: ReturnType<typeof createDb>;
let redis: Redis;

const cfg = () =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: { "device-fake": { root, updateMode: "updated" } },
    extensionPermissions: { autoApprove: true },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-modes-dual-"));
  raw = createDb(pgc.url, 2);
  redis = new Redis(rdc.url);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const k of [...kernels, ...fencingKernels]) await k.close();
  redis?.disconnect();
  await raw?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  for (const r of roots) await rm(r, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

/**
 * An org, a member account, its device and `use`: one managed use of the device on a replica, as
 * a tool call of a new root conversation of the account bound to the device.
 */
async function seed() {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const deviceId = randomUUID();
  const agentId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${accountId}, 'owner')`.execute(raw);
  await enableFakeProvider(raw, orgId);
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, provider)
    VALUES (${deviceId}, ${orgId}, 'personal', ${accountId}, 'device-fake')`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  const use = async <T>(k: TestKernel, fn: Parameters<typeof managedUseOn<T>>[3]): Promise<T> => {
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
    return managedUseOn(
      k,
      raw,
      {
        orgId,
        deviceId,
        holderConversationId: conversationId,
        actor: { accountId, conversationId },
      },
      fn,
    );
  };
  return { orgId, accountId, deviceId, use };
}

/** Resolves once `k` tried for the device's exclusive lease and found it held (it now waits). */
function exclusiveRefused(k: TestKernel): Promise<void> {
  const leases = k.app.get(SandboxLeases);
  const original = leases.tryExclusive.bind(leases);
  return new Promise<void>((resolve) => {
    vi.spyOn(leases, "tryExclusive").mockImplementation(async (...args) => {
      const lease = await original(...args);
      if (lease === null) resolve();
      return lease;
    });
  });
}

const setAutoMode = (orgId: string, mode: "allowed" | "off") =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
    outsideSandbox: mode,
    deviceNetwork: mode === "off" ? { ceiling: "allowlist" } : { default: "open" },
  })}::jsonb
    WHERE id = ${orgId}`.execute(raw);

describe("device modes (two replicas)", () => {
  it("a mode changed while both replicas use the device is applied once; both then use the updated instance", async () => {
    const [k1, k2] = await Promise.all([startKernel(cfg()), startKernel(cfg())]);
    kernels.push(k1, k2);
    const { orgId, deviceId, use: useOn } = await seed();
    const use = (k: TestKernel) => useOn(k, async (h, _p, info) => ({ h, info }));
    const first = await use(k1);
    expect(first.info.fresh).toBe(true);

    // the org route writes the setting on one replica; the next uses read it from PG
    await setAutoMode(orgId, "off");
    await setFakeSandboxDelays(root, { update: 300 });
    const [a, b] = await Promise.all([use(k1), use(k2)]);
    expect(a.h).toEqual(first.h);
    expect(b.h).toEqual(first.h);
    const ops = await readFakeSandboxOps(root);
    expect(ops.filter((o) => o[0] === "update")).toEqual([["update", first.h.id, "updated"]]);
    expect(ops.filter((o) => o[0] === "create")).toHaveLength(1);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates.map((e) => e.limits.network.kind)).toEqual(["allowlist"]);
    const row = await sql<{ instance_limits: unknown }>`SELECT instance_limits
      FROM capybara.device_instances WHERE device_id = ${deviceId}`.execute(raw);
    expect(row.rows[0]?.instance_limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist" },
    });
    await setFakeSandboxDelays(root, {});
  });

  it("a replica that read a mode before waiting applies the mode read under the lease", async () => {
    const [k1, k2] = kernels as [TestKernel, TestKernel];
    const { orgId, deviceId, use } = await seed();
    const first = await use(k1, async (h) => h);
    const before = (await readFakeSandboxLimits(root)).length;

    // replica 1 holds the instance (a shared lease) while replica 2 reads the new mode and waits
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const holder = use(k1, async () => {
      entered();
      await held;
    });
    await inside;
    await setAutoMode(orgId, "off");
    const waiting = exclusiveRefused(k2);
    const waiter = use(k2, async (h, _p, info) => ({ h, info }));
    await waiting;
    release();
    await holder;
    const again = await waiter;
    expect(again.h).toEqual(first);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    const applied = (await readFakeSandboxLimits(root)).slice(before);
    expect(applied.map((e) => [e.op, e.limits.network.kind])).toEqual([["update", "allowlist"]]);
    const row = await sql<{ instance_limits: unknown }>`SELECT instance_limits
      FROM capybara.device_instances WHERE device_id = ${deviceId}`.execute(raw);
    expect(row.rows[0]?.instance_limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist" },
    });
  });
});

/**
 * Device update fencing (design `2026-11-23-device-update-fencing-design.md` §9): two replicas
 * sharing PG, Redis and the fake provider's root. Replica A sends an `update` that stays in flight
 * (held inside the fake after it took its arguments, before it checks and stores) while its lease
 * ends; replica B takes the lease and applies the desired, narrower list. The fake refuses A's
 * late call by its lower token, and the intent A recorded first makes B apply the desired list
 * even though the record of what succeeded already matched it. With the fake set to ignore the
 * fence, the same race ends with the provider enforcing A's wider list while PG records the narrow
 * one: the proof that the test measures the race. A provider that cannot honor the fence (E2B)
 * reports the network it enforces (`appliedNetwork`), so the next lifecycle step on either replica
 * narrows that wider list again (issue #766). These replica pairs run on their own provider roots,
 * next to the pair above.
 */

const fencingKernels: TestKernel[] = [];
const roots: string[] = [];

const fencingCfg = (root: string, fencing: "enforce" | "ignore") =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: {
      "device-fake": { root, updateMode: "updated", fencing, reportsNetwork: true },
    },
    extensionPermissions: { autoApprove: true },
  });

/** Two replicas over one new provider root, the fake enforcing or ignoring the fence. */
async function fencingReplicas(fencing: "enforce" | "ignore") {
  const root = await mkdtemp(join(tmpdir(), `cap-update-fencing-${fencing}-`));
  roots.push(root);
  const [a, b] = await Promise.all([
    startKernel(fencingCfg(root, fencing)),
    startKernel(fencingCfg(root, fencing)),
  ]);
  fencingKernels.push(a, b);
  return { root, a, b };
}

/** An org on the allowlist network, a member, its device and `use` (one managed use on a replica). */
async function fencingSeed() {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const deviceId = randomUUID();
  const agentId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${accountId}, 'owner')`.execute(raw);
  await enableFakeProvider(raw, orgId);
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, provider)
    VALUES (${deviceId}, ${orgId}, 'personal', ${accountId}, 'device-fake')`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  /** The org's allowlist: the base list plus `extra`. */
  const setHosts = (extra: string[]) =>
    sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
      outsideSandbox: "off",
      deviceNetwork: { ceiling: "allowlist", extraHosts: extra },
    })}::jsonb WHERE id = ${orgId}`.execute(raw);
  const use = async (k: TestKernel) => {
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
    return managedUseOn(
      k,
      raw,
      {
        orgId,
        deviceId,
        holderConversationId: conversationId,
        actor: { accountId, conversationId },
      },
      async (h) => h,
    );
  };
  /** Ends every lease on the device, as an expiry would (the holder does not notice). */
  const expireLeases = async () => {
    await redis.del(`capk:sandbox:${deviceId}`, `capk:sandbox-users:${deviceId}`);
  };
  const recorded = async () =>
    (
      await sql<{ instance_limits: Record<string, unknown> | null }>`SELECT instance_limits
        FROM capybara.device_instances WHERE device_id = ${deviceId}`.execute(raw)
    ).rows[0]?.instance_limits ?? null;
  await setHosts([]);
  return { deviceId, setHosts, use, expireLeases, recorded };
}

const hostsOf = (v: unknown): string[] =>
  ((v as { network?: { hosts?: string[] } } | null | undefined)?.network?.hosts ?? []).slice();

/** Resolves once the fake logged that it holds an update under `label`. */
const heldUpdate = (root: string, label: string) =>
  vi.waitFor(
    async () => {
      const line = (await readFakeSandboxOps(root)).find(
        (o) => o[0] === "update-held" && o[3] === label,
      );
      if (!line) throw new Error(`update ${label} not held yet`);
      return { instance: line[1] as string, token: Number(line[2]) };
    },
    { timeout: 20_000, interval: 20 },
  );

/** The updates the fake took (arguments captured, before any check), oldest first. */
const updates = async (root: string) =>
  (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");

/**
 * Steps 1 to 4 of the design's scenario: the instance on the base list; A's use sends the base
 * list plus `b.example` and is held in flight; the org removes `b.example` again; A's lease ends;
 * B's use (started here, not awaited) takes the lease. Returns both uses, A's held call, and B's.
 */
async function race(root: string, a: TestKernel, b: TestKernel, holdB: boolean) {
  const s = await fencingSeed();
  const created = await s.use(a);
  await s.setHosts(["b.example"]);
  // labels unique to this race: the provider root is shared by the tests of a replica pair
  const labels = { a: `A-${randomUUID().slice(0, 8)}`, b: `B-${randomUUID().slice(0, 8)}` };
  await holdNextFakeSandboxUpdate(root, labels.a);
  const useA = s.use(a);
  // settled is observed later; an unhandled rejection meanwhile is not a failure
  useA.catch(() => {});
  const heldA = await heldUpdate(root, labels.a);
  await s.setHosts([]);
  await s.expireLeases();
  if (holdB) await holdNextFakeSandboxUpdate(root, labels.b);
  const useB = s.use(b);
  useB.catch(() => {});
  return { ...s, created, useA, heldA, useB, labels };
}

describe("device update fencing (two replicas)", () => {
  it("a stale replica's update that arrives after the newer holder's is refused; nothing recreated", async () => {
    const { root, a, b } = await fencingReplicas("enforce");
    const r = await race(root, a, b, false);
    // B applied the desired list (the record matched it already: the intent made B send it)
    expect(await r.useB).toEqual(r.created);
    const [first, second] = await updates(root);
    expect(hostsOf(first?.limits)).toContain("b.example");
    expect(hostsOf(second?.limits)).not.toContain("b.example");
    expect(second?.fence).toBeGreaterThan(r.heldA.token);
    // A's request lands now
    await releaseFakeSandboxUpdate(root, r.labels.a);
    await expect(r.useA).rejects.toBeInstanceOf(SandboxLockLostError);
    const ops = await readFakeSandboxOps(root);
    expect(ops.filter((o) => o[0] === "stale-fence")).toEqual([
      ["stale-fence", r.created.id, "update", String(r.heldA.token), String(second?.fence)],
    ]);
    // provider and record agree on the narrow list; the instance was never recreated
    const meta = await fakeSandboxMeta(root, r.created.id as string);
    expect(hostsOf(meta?.limits)).not.toContain("b.example");
    const rec = await r.recorded();
    expect(hostsOf(rec)).not.toContain("b.example");
    expect(rec?.pending).toBeUndefined();
    expect(ops.filter((o) => o[0] === "create")).toHaveLength(1);
    expect(ops.filter((o) => o[0] === "destroy")).toHaveLength(0);
  });

  it("no newer write needed: the stale call lands first, the next holder still narrows it", async () => {
    const { root, a, b } =
      fencingKernels.length >= 2
        ? {
            root: roots[0] as string,
            a: fencingKernels[0] as TestKernel,
            b: fencingKernels[1] as TestKernel,
          }
        : await fencingReplicas("enforce");
    const before = (await updates(root)).length;
    const r = await race(root, a, b, true);
    const heldB = await heldUpdate(root, r.labels.b);
    expect(heldB.token).toBeGreaterThan(r.heldA.token);
    // A's late call reaches the provider before B's: the fake applies it (its token is newer
    // than anything the instance has seen); A's record write fails, B already moved the fence
    await releaseFakeSandboxUpdate(root, r.labels.a);
    await expect(r.useA).rejects.toBeInstanceOf(SandboxLockLostError);
    expect(hostsOf((await fakeSandboxMeta(root, r.created.id as string))?.limits)).toContain(
      "b.example",
    );
    // B's call, sent only because the row carried A's intent, narrows it again
    await releaseFakeSandboxUpdate(root, r.labels.b);
    expect(await r.useB).toEqual(r.created);
    const sent = (await updates(root)).slice(before);
    expect(sent.map((e) => hostsOf(e.limits).includes("b.example"))).toEqual([true, false]);
    expect(hostsOf((await fakeSandboxMeta(root, r.created.id as string))?.limits)).not.toContain(
      "b.example",
    );
    const rec = await r.recorded();
    expect(hostsOf(rec)).not.toContain("b.example");
    expect(rec?.pending).toBeUndefined();
  });

  it("without the fence the same race leaves the provider wider than the record (red proof); the next lifecycle step narrows it", async () => {
    const { root, a, b } = await fencingReplicas("ignore");
    const r = await race(root, a, b, false);
    expect(await r.useB).toEqual(r.created);
    await releaseFakeSandboxUpdate(root, r.labels.a);
    // A's record write still fails (its generation moved) ...
    await expect(r.useA).rejects.toBeInstanceOf(SandboxLockLostError);
    // ... but its wider list is what the provider now enforces, behind the record's back
    expect(hostsOf((await fakeSandboxMeta(root, r.created.id as string))?.limits)).toContain(
      "b.example",
    );
    const rec = await r.recorded();
    expect(hostsOf(rec)).not.toContain("b.example");
    expect(rec?.pending).toBeUndefined();

    // #766: the record already matches the desired list, so only the installed network can tell.
    // The idle sweep suspends the instance; the next use (on the replica that sent the stale call)
    // resumes it, reads the wider network and applies the desired list again with its own token
    const before = (await updates(root)).length;
    await b.app.get(SandboxService).suspendIdle(new Date(Date.now() + 24 * 60 * 60_000));
    expect(await r.use(a)).toEqual(r.created);
    const sent = (await updates(root)).slice(before);
    expect(sent.map((e) => hostsOf(e.limits).includes("b.example"))).toEqual([false]);
    expect(hostsOf((await fakeSandboxMeta(root, r.created.id as string))?.limits)).not.toContain(
      "b.example",
    );
    expect(await r.recorded()).toEqual(rec);
    const ops = await readFakeSandboxOps(root);
    expect(ops.filter((o) => o[0] === "applied-network")).toHaveLength(1);
    expect(ops.filter((o) => o[0] === "create")).toHaveLength(1);
  });
});
