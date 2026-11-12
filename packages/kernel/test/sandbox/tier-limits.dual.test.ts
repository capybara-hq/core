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
 * and a device whose tier changes (sandbox dev tiers spec §7.1, §10.3): the change is read from PG
 * at each use, and the replicas using the device at once apply it exactly once, under the
 * exclusive lease; the other waits and then uses the updated instance.
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
    sandbox: { tiers: { max: "open", default: "dev" } },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-tiers-dual-"));
  raw = createDb(pgc.url, 2);
}, 120_000);

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
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by, settings)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId},
      ${JSON.stringify({ sandboxTier: { max: "open" } })}::jsonb)`.execute(raw);
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, source)
    VALUES (${deviceId}, ${orgId}, 'personal', ${accountId}, 'cloud')`.execute(raw);
  return { orgId, accountId, deviceId };
}

describe("sandbox tiers (two replicas)", () => {
  it("a tier changed while both replicas use the device is applied once; both then use the updated instance", async () => {
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

    // the device route writes the row on one replica (task C2); the next uses read it from PG
    await sql`UPDATE capybara.devices SET tier = 'open' WHERE id = ${deviceId}`.execute(raw);
    await setFakeSandboxDelays(root, { update: 300 });
    const [a, b] = await Promise.all([use(k1), use(k2)]);
    expect(a.h).toEqual(first.h);
    expect(b.h).toEqual(first.h);
    const ops = await readFakeSandboxOps(root);
    expect(ops.filter((o) => o[0] === "update")).toEqual([["update", first.h.id, "updated"]]);
    expect(ops.filter((o) => o[0] === "create")).toHaveLength(1);
    const updates = (await readFakeSandboxLimits(root)).filter((e) => e.op === "update");
    expect(updates.map((e) => [e.limits.tier, e.limits.egress])).toEqual([["open", "open"]]);
    const row = await sql<{ instance_limits: unknown }>`SELECT instance_limits
      FROM capybara.device_instances WHERE device_id = ${deviceId}`.execute(raw);
    expect(row.rows[0]?.instance_limits).toEqual({ tier: "open", egress: "open" });
    await setFakeSandboxDelays(root, {});
  }, 60_000);
});
