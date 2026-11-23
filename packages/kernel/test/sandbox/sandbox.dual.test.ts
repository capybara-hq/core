import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { SANDBOX_DESTROY_JOB, SANDBOX_SUSPEND_JOB } from "../../src/sandbox/jobs.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { readFakeSandboxOps, setFakeSandboxDelays } from "../fixtures/plugins/device-fake/index.js";
import { managedUseOn } from "../helpers/managed-calls.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { enableFakeProvider } from "../helpers/sandbox.js";

/**
 * Two kernel replicas (two independent kernels in one process: own PG pools, Redis connections and
 * extension instances; shared PG, Redis and the fake provider's backend directory) use one device
 * for the first time at once, each as a tool call of a conversation on it (the managed route): only
 * one instance is created, the other replica waits for the lease and reuses it.
 *
 * The service keeps no in-process state, so two kernels in one process coordinating only through
 * PG and Redis are equivalent to two processes.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
const kernels: TestKernel[] = [];
let raw: ReturnType<typeof createDb>;

const cfg = (plugins: string[], roles: string[] = ["api"]) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles,
    extensions: plugins,
    extensionConfig: { "device-fake": { root } },
    extensionPermissions: { autoApprove: true },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-dual-"));
  raw = createDb(pgc.url, 2);
});

afterAll(async () => {
  for (const k of kernels) await k.close();
  await raw?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

interface Seeded {
  orgId: string;
  deviceId: string;
  holderConversationId: string;
  actor: { accountId: string; conversationId: string };
}

/**
 * An org, a member account, a root conversation of it and the account's device: a use context.
 * The conversation is left unbound (a managed use binds it to the device).
 */
async function seedConversation(): Promise<Seeded & { agentId: string }> {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${accountId}, 'owner')`.execute(raw);
  await enableFakeProvider(raw, orgId);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  const deviceId = randomUUID();
  await sql`INSERT INTO capybara.devices (id, org_id, owner_kind, owner_account_id, provider)
    VALUES (${deviceId}, ${orgId}, 'personal', ${accountId}, 'device-fake')`.execute(raw);
  return {
    orgId,
    deviceId,
    agentId,
    holderConversationId: conversationId,
    actor: { accountId, conversationId },
  };
}

/** Another root conversation of the same account on the same device (a second holder). */
async function secondHolder(ctx: Seeded & { agentId: string }): Promise<Seeded> {
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
    VALUES (${conversationId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.actor.accountId},
      ${ctx.deviceId})`.execute(raw);
  return {
    orgId: ctx.orgId,
    deviceId: ctx.deviceId,
    holderConversationId: conversationId,
    actor: { accountId: ctx.actor.accountId, conversationId },
  };
}

describe("sandbox (two replicas)", () => {
  it("two replicas using one device for the first time at once: one file system and one instance, both get the same handle", async () => {
    const [k1, k2] = await Promise.all([
      startKernel(cfg([SANDBOX_FAKE], ["api", "worker"])),
      startKernel(cfg([SANDBOX_FAKE])),
    ]);
    kernels.push(k1, k2);
    const ctx = await seedConversation();
    expect(await k1.app.get(SandboxService).availableFor(ctx.deviceId, ctx.orgId)).toBe(true);
    expect(await k2.app.get(SandboxService).availableFor(ctx.deviceId, ctx.orgId)).toBe(true);
    await setFakeSandboxDelays(root, { create: 300 });

    // each replica's use is a tool call of its own conversation's claimed run on the device
    const other = await secondHolder(ctx);
    const use = (k: TestKernel, holder: Seeded) =>
      managedUseOn(k, raw, holder, async (h, _p, info) => ({ h, info }));
    const [a, b] = await Promise.all([use(k1, ctx), use(k2, other)]);
    expect(a.h).toEqual(b.h);
    expect([a.info.fresh, b.info.fresh].sort()).toEqual([false, true]);
    const ops = await readFakeSandboxOps(root);
    expect(ops.filter((o) => o[0] === "create")).toHaveLength(1);
    expect(ops.filter((o) => o[0] === "create-fs")).toHaveLength(1);
    const rows = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM capybara.device_instances`.execute(raw);
    expect(rows.rows[0]?.n).toBe(1);
    // the test boots both kernels itself: under a loaded parallel run that alone can pass 5 s
  });

  it("both sweeps are @LockedCron jobs (every minute / hourly) whose names contain no `:`", async () => {
    // the worker kernel of the first case (crons instead of maintenance schedulers)
    const registry = kernels[0]?.app.get(SchedulerRegistry);
    if (!registry) throw new Error("the worker kernel of the first case is missing");
    expect(String(registry.getCronJob(SANDBOX_SUSPEND_JOB).cronTime.source)).toBe("* * * * *");
    expect(String(registry.getCronJob(SANDBOX_DESTROY_JOB).cronTime.source)).toBe("0 * * * *");
    for (const id of [SANDBOX_SUSPEND_JOB, SANDBOX_DESTROY_JOB]) expect(id).not.toContain(":");
  });

  it("a kernel without the device's provider: not available, a use answers 503 device.unavailable", async () => {
    const k = await startKernel(cfg([]));
    kernels.push(k);
    const ctx = await seedConversation();
    expect(await k.app.get(SandboxService).availableFor(ctx.deviceId, ctx.orgId)).toBe(false);
    const fn = vi.fn(async () => 1);
    const err = await managedUseOn(k, raw, ctx, fn).catch((e: unknown) => e);
    expect(fn).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe("device.unavailable");
  });
});
