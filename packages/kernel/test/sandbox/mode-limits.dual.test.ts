import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createDb } from "../../src/db/pool.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  readFakeSandboxLimits,
  readFakeSandboxOps,
  setFakeSandboxDelays,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Two kernel replicas (two kernels in one process sharing PG, Redis and the fake provider's root)
 * and a device whose effective mode changes (auto mode spec §4.2, §4.3): the org's `autoMode` is
 * read from PG at each use, and the replicas using the device at once apply it exactly once, under
 * the exclusive lease; the other waits and then uses the updated instance.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
const kernels: TestKernel[] = [];
let raw: ReturnType<typeof createDb>;

const cfg = () =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: { "sandbox-fake": { root, updateMode: "updated" } },
    extensionPermissions: { autoApprove: true },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-modes-dual-"));
  raw = createDb(pgc.url, 2);
});

afterAll(async () => {
  for (const k of kernels) await k.close();
  await raw?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

async function seed() {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const deviceId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, source)
    VALUES (${deviceId}, ${orgId}, 'personal', ${accountId}, 'cloud')`.execute(raw);
  return { orgId, accountId, deviceId };
}

const setAutoMode = (orgId: string, mode: "allowed" | "off") =>
  sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
    autoMode: mode,
    cloudNetwork: { mode: mode === "off" ? "allowlist" : "open" },
  })}::jsonb
    WHERE id = ${orgId}`.execute(raw);

describe("device modes (two replicas)", () => {
  it("a mode changed while both replicas use the device is applied once; both then use the updated instance", async () => {
    const [k1, k2] = await Promise.all([startKernel(cfg()), startKernel(cfg())]);
    kernels.push(k1, k2);
    const { orgId, accountId, deviceId } = await seed();
    const use = (k: TestKernel) =>
      k.app.get(SandboxService).withSandbox(
        {
          orgId,
          deviceId,
          holderConversationId: randomUUID(),
          actor: { accountId, conversationId: randomUUID() },
        },
        async (h, _p, info) => ({ h, info }),
        AbortSignal.timeout(30_000),
      );
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
    expect(updates.map((e) => [e.limits.mode, e.limits.network.kind])).toEqual([
      ["sandbox", "allowlist"],
    ]);
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
    const { orgId, accountId, deviceId } = await seed();
    const ctx = () => ({
      orgId,
      deviceId,
      holderConversationId: randomUUID(),
      actor: { accountId, conversationId: randomUUID() },
    });
    const first = await k1.app
      .get(SandboxService)
      .withSandbox(ctx(), async (h) => h, AbortSignal.timeout(30_000));
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
    const holder = k1.app.get(SandboxService).withSandbox(
      ctx(),
      async () => {
        entered();
        await held;
      },
      AbortSignal.timeout(30_000),
    );
    await inside;
    await setAutoMode(orgId, "off");
    const waiter = k2.app
      .get(SandboxService)
      .withSandbox(ctx(), async (h, _p, info) => ({ h, info }), AbortSignal.timeout(30_000));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const again = await waiter;
    expect(again.h).toEqual(first);
    expect(again.info).toMatchObject({ fresh: false, restarted: false });
    const applied = (await readFakeSandboxLimits(root)).slice(before);
    expect(applied.map((e) => [e.op, e.limits.mode])).toEqual([["update", "sandbox"]]);
    const row = await sql<{ instance_limits: unknown }>`SELECT instance_limits
      FROM capybara.device_instances WHERE device_id = ${deviceId}`.execute(raw);
    expect(row.rows[0]?.instance_limits).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist" },
    });
  });
});
