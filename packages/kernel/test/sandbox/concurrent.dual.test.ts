import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox, readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxServiceFor } from "../helpers/sandbox.js";

/**
 * Concurrent sandbox holders on two replicas (sub-agents spec §10.5, §10.9; environments spec
 * §4.2: several conversations share one environment's instance). Each replica
 * is a `SandboxService` with its own PG pool and Redis connection, sharing PG, Redis and the fake
 * sandbox's provider root; the service keeps no state in process, so this equals two processes.
 * A replica "crashes" by losing its Redis connection while its command keeps running in the
 * sandbox (its provider ignores the abort, as a dead process would never send the kill).
 */

vi.setConfig({ testTimeout: 60_000 });

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
let config: KernelConfig;
const pools: ReturnType<typeof createDb>[] = [];
const clients: Redis[] = [];
const log = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
}, 120_000);

afterAll(async () => {
  for (const c of clients) c.disconnect();
  for (const p of pools) await p.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const replica = (impl: SandboxProvider, o: { ttlMs?: number } = {}) => {
  const pool = createDb(pgc.url, 4);
  const redis = new Redis(rdc.url);
  pools.push(pool);
  clients.push(redis);
  const s = sandboxServiceFor({
    db: kernelDb(pool),
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl }),
    config: () => config,
    log,
    lockPollMs: 20,
    ...(o.ttlMs === undefined ? {} : { lockTtlMs: o.ttlMs }),
  });
  return { s, redis };
};

let orgId: string;
let conversationId: string;
/** A second conversation bound to the same environment. */
let convB: string;
let accountId: string;
let envId: string;

beforeEach(async () => {
  const raw = createDb(pgc.url, 1);
  try {
    const r = new Redis(rdc.url);
    await r.flushdb();
    r.disconnect();
    await truncateTables(
      raw,
      "capybara.environment_instances, capybara.environments, capybara.accounts, capybara.orgs",
    );
    accountId = randomUUID();
    orgId = randomUUID();
    const agentId = randomUUID();
    conversationId = randomUUID();
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
      VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
    convB = randomUUID();
    for (const id of [conversationId, convB]) {
      await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
        VALUES (${id}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
    }
    envId = randomUUID();
    await sql`INSERT INTO capybara.environments (id, org_id, owner_kind, owner_account_id, source)
      VALUES (${envId}, ${orgId}, 'personal', ${accountId}, 'cloud')`.execute(raw);
  } finally {
    await raw.destroy();
  }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-ccd-"));
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sandbox: { maxConcurrentCommands: 4 },
  });
});

const ctx = (conv = conversationId) => ({
  orgId,
  environmentId: envId,
  holderConversationId: conv,
  actor: { accountId, conversationId: conv },
});
const signal = () => AbortSignal.timeout(50_000);
const run = (s: SandboxService, command: string, conv = conversationId) =>
  s.withSandbox(
    ctx(conv),
    async (h, p, info, sig) => ({
      info,
      r: await p.exec(h, { command, timeoutMs: 40_000, maxOutputBytes: 1000, signal: sig }),
    }),
    signal(),
  );
const ops = async (op: string) => (await readFakeSandboxOps(root)).filter((o) => o[0] === op);
const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("concurrent sandbox holders (two replicas)", () => {
  it("crashed holder in a shared environment kills only its tags", async () => {
    const fake = createFakeSandbox(root);
    // A dies with its command still running: its provider never kills on abort
    const deaf: SandboxProvider = {
      ...fake,
      exec: (h, a) => fake.exec(h, { ...a, signal: new AbortController().signal }),
    };
    const a = replica(deaf, { ttlMs: 1500 });
    const b = replica(fake);
    await run(b.s, "true", convB);
    const holders = `capk:sandbox-holders:${envId}`;

    // conversation A on replica A and conversation B on replica B share the environment
    const aCall = run(a.s, "sleep 30", conversationId);
    const bCall = run(b.s, "sleep 4; echo b-done", convB);
    await until(async () => (await b.redis.hlen(holders)) === 2);
    // both commands run at the same time under shared leases
    expect(await b.redis.zcard(`capk:sandbox-users:${envId}`)).toBe(2);
    // no single "sandbox in use" marker: holder records are per holder
    expect(await b.redis.keys("capk:sandbox-busy:*")).toEqual([]);

    // replica A crashes: no renewals, no unregister, its lease expires after its TTL
    a.redis.disconnect();
    await new Promise((r) => setTimeout(r, 2000));

    // B's next acquisition finds A's record without a lease and kills only A's tag
    const next = await run(b.s, "echo next", convB);
    expect(next.r.stdout).toBe("next\n");
    expect((await aCall).r.exitCode).toBeNull();
    // B's running command survived
    const bResult = await bCall;
    expect(bResult.r.exitCode).toBe(0);
    expect(bResult.r.stdout).toBe("b-done\n");
    // exactly A's tag was killed: the tag of conversation A's exec, none of B's
    const execs = await ops("exec");
    const tagsOf = (conv: string) => execs.filter((o) => o[6] === conv).map((o) => o[2]);
    expect(tagsOf(conversationId)).toHaveLength(1);
    expect((await ops("kill-tagged")).map((o) => o[2])).toEqual(tagsOf(conversationId));
    expect(tagsOf(convB)).not.toContain(tagsOf(conversationId)[0]);
    expect(await ops("kill-all")).toHaveLength(0);
  });

  it("suspendIdle skips while any holder is live and suspends after the last one ends", async () => {
    const fake = createFakeSandbox(root);
    const a = replica(fake);
    const b = replica(fake);
    await run(a.s, "true");
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    let inside = 0;
    const hold = (s: SandboxService, gate: Promise<void>) =>
      s.withSandbox(
        ctx(),
        async () => {
          inside++;
          await gate;
        },
        signal(),
      );
    const ha = hold(a.s, gateA);
    const hb = hold(b.s, gateB);
    await until(async () => inside === 2);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await a.s.suspendIdle(later)).toBe(0);
    releaseA();
    await ha;
    expect(await b.s.suspendIdle(later)).toBe(0);
    releaseB();
    await hb;
    expect(await a.s.suspendIdle(later)).toBe(1);
    expect(await ops("suspend")).toHaveLength(1);
  });
});
