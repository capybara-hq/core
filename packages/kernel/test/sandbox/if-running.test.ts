import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  createFakeSandbox,
  fakeSandboxState,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { sandboxLeasesFor, sandboxServiceFor } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Background Bash support in the sandbox service (spec 2026-11-05-background-bash-design §4.3):
 * the non-resuming `ifRunning`, `currentInstance`, and the kills of lost tasks after a resume.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let seed: Awaited<ReturnType<typeof seedConversation>>;
/** Provider calls seen through the spy: `create` / `resume` and every exec command. */
let calls: string[];
let execs: string[];

const signal = () => AbortSignal.timeout(30_000);
const DAY = 24 * 3600_000;

/** The fake sandbox with its lifecycle calls and exec commands recorded. */
function spied(impl: SandboxProvider): SandboxProvider {
  const w = Object.create(impl) as SandboxProvider;
  w.create = (args) => {
    calls.push("create");
    return impl.create(args);
  };
  w.resume = (h, s) => {
    calls.push("resume");
    return impl.resume(h, s);
  };
  w.exec = (h, args) => {
    execs.push(args.command);
    return impl.exec(h, args);
  };
  return w;
}

let provider: SandboxProvider;
const service = (): SandboxService =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: provider }),
    config: () => config,
    log: {},
    lockPollMs: 20,
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(raw, "capybara.sandboxes, capybara.accounts, capybara.orgs");
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "cap-if-running-"));
  calls = [];
  execs = [];
  provider = spied(createFakeSandbox(root));
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  seed = await seedConversation(raw);
});

const conv = () => seed.conversationId;
const use = (s: SandboxService) =>
  s.withSandbox({ orgId: seed.orgId, conversationId: conv() }, async (h) => h, signal());
const row = () =>
  db.selectFrom("sandboxes").selectAll().where("conversation_id", "=", conv()).executeTakeFirst();

/** A finished task of the conversation's sandbox marked `kill_pending`. */
async function lostTask(sid: string, sandboxCreatedAt: Date): Promise<string> {
  const id = `bt_${randomUUID().slice(0, 6)}`;
  await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
      sandbox_conversation_id, run_id, call_id, trigger_account_id, description, command, sid,
      output_path, status, lost_reason, finished_at, deadline_at, sandbox_created_at, kill_pending)
    VALUES (${id}, ${seed.orgId}, ${conv()}, ${conv()}, 'run-1', 'call-1', ${seed.accountId},
      'd', 'sleep 600', ${sid}, ${`.capybara/tasks/${id}.out`}, 'lost', 'sandbox_suspended', now(),
      now() + interval '1 hour', ${sandboxCreatedAt}, true)`.execute(raw);
  return id;
}
const killPending = async (id: string) =>
  (
    await sql<{ kill_pending: boolean }>`SELECT kill_pending FROM capybara.background_tasks
      WHERE id = ${id}`.execute(raw)
  ).rows[0]?.kill_pending;

describe("currentInstance", () => {
  it("is null without a sandbox, the instance's created_at while it runs or is suspended", async () => {
    const s = service();
    expect(await s.currentInstance(conv())).toBeNull();
    await use(s);
    const r = await row();
    expect(await s.currentInstance(conv())).toEqual({ createdAt: r?.created_at });
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    expect(await s.currentInstance(conv())).toEqual({ createdAt: r?.created_at });
    await s.destroyFor(conv());
    expect(await s.currentInstance(conv())).toBeNull();
  });
});

describe("ifRunning", () => {
  it("returns not_running without a sandbox and never creates one", async () => {
    const s = service();
    let ran = false;
    const r = await s.ifRunning(conv(), { createdAt: new Date() }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "not_running" });
    expect(ran).toBe(false);
    expect(await row()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("on a suspended sandbox returns not_running, leaves it suspended, creates and resumes nothing", async () => {
    const s = service();
    const h = await use(s);
    const instance = await s.currentInstance(conv());
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    calls = [];
    execs = [];
    let ran = false;
    const r = await s.ifRunning(conv(), instance as { createdAt: Date }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "not_running" });
    expect(ran).toBe(false);
    expect((await row())?.status).toBe("suspended");
    expect(await fakeSandboxState(root, h.id)).toBe("suspended");
    expect(calls).toEqual([]);
    expect(execs).toEqual([]);
    expect((await readFakeSandboxOps(root)).filter((o) => o[0] === "autostart")).toEqual([]);
  });

  it("with a stale createdAt returns other_instance and does not run fn", async () => {
    const s = service();
    await use(s);
    const instance = await s.currentInstance(conv());
    const stale = new Date((instance?.createdAt.getTime() ?? 0) - 60_000);
    let ran = false;
    const r = await s.ifRunning(conv(), { createdAt: stale }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "other_instance" });
    expect(ran).toBe(false);
  });

  it("on the running instance runs fn under a shared lease (tagged execs) and refreshes last_used_at", async () => {
    const s = service();
    const h = await use(s);
    const instance = await s.currentInstance(conv());
    const old = new Date(Date.now() - DAY);
    await db
      .updateTable("sandboxes")
      .set({ last_used_at: old })
      .where("conversation_id", "=", conv())
      .execute();
    const leases = sandboxLeasesFor({ redis, log: {} });
    calls = [];
    const r = await s.ifRunning(conv(), instance as { createdAt: Date }, async (p, handle, sig) => {
      expect(handle).toEqual(h);
      // an exclusive lease (a suspension, a resume) cannot get in while fn runs
      expect(await leases.tryExclusive(conv())).toBeNull();
      const out = await p.exec(handle, {
        command: "echo ok",
        timeoutMs: 5000,
        maxOutputBytes: 100,
        signal: sig,
      });
      return out.stdout;
    });
    expect(r).toEqual({ kind: "ran", value: "ok\n" });
    expect(calls).toEqual([]);
    const tags = (await readFakeSandboxOps(root))
      .filter((o) => o[0] === "exec" && o[1] === h.id)
      .map((o) => o[2]);
    expect(tags.at(-1)).not.toBe("-");
    expect((await row())?.last_used_at.getTime()).toBeGreaterThan(old.getTime());
    // the lease is released afterwards
    const ex = await leases.tryExclusive(conv());
    expect(ex).not.toBeNull();
    await ex?.release();
  });
});

describe("ifRunning with a signal", () => {
  it("gives up waiting for the lease promptly when the signal aborts", async () => {
    const s = service();
    await use(s);
    const instance = (await s.currentInstance(conv())) as { createdAt: Date };
    const leases = sandboxLeasesFor({ redis, log: {} });
    const held = await leases.tryExclusive(conv());
    expect(held).not.toBeNull();
    try {
      const ac = new AbortController();
      let ran = false;
      const t0 = Date.now();
      const pending = s.ifRunning(
        conv(),
        instance,
        async () => {
          ran = true;
        },
        ac.signal,
      );
      setTimeout(() => ac.abort(new Error("shutting down")), 200);
      await expect(pending).rejects.toThrow("shutting down");
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(ran).toBe(false);
    } finally {
      await held?.release();
    }
  });
});

describe("kills of lost tasks after a resume", () => {
  // 4242 / 777 have no session record in the fake, so its pkill matches nothing on the host
  it("runs one kill exec naming the sid of this instance's task and clears every flag", async () => {
    const s = service();
    await use(s);
    const instance = (await s.currentInstance(conv())) as { createdAt: Date };
    const mine = await lostTask("4242", instance.createdAt);
    const older = await lostTask("777", new Date(instance.createdAt.getTime() - 60_000));
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    execs = [];
    await use(s);
    expect(calls).toContain("resume");
    const kills = execs.filter((c) => c.includes("pkill -KILL -s"));
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatch(/\b4242\b/);
    expect(kills[0]).not.toMatch(/\b777\b/);
    expect(await killPending(mine)).toBe(false);
    expect(await killPending(older)).toBe(false);
  });

  it("kills a session that is still alive after the resume", async () => {
    // a provider whose suspension keeps processes (E2B's pause): the fake's suspend kills them,
    // so the session is started after the resume, standing in for one that survived
    const s = service();
    await use(s);
    const instance = (await s.currentInstance(conv())) as { createdAt: Date };
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    const h = await use(s);
    const started = await provider.exec(h, {
      command: "setsid sh -c 'sleep 30' > /dev/null 2>&1 & echo $!",
      timeoutMs: 5000,
      maxOutputBytes: 100,
      signal: signal(),
    });
    const sid = started.stdout.trim();
    const id = await lostTask(sid, instance.createdAt);
    const alive = () =>
      provider.exec(h, {
        command: `pgrep -s ${sid}`,
        timeoutMs: 5000,
        maxOutputBytes: 1000,
        signal: signal(),
      });
    expect((await alive()).exitCode).toBe(0);
    // the next resume: mark the row suspended without the fake killing anything
    await db
      .updateTable("sandboxes")
      .set({ status: "suspended" })
      .where("conversation_id", "=", conv())
      .execute();
    await use(s);
    expect((await alive()).exitCode).toBe(1);
    expect(await killPending(id)).toBe(false);
  });

  it("clears the flags of a rebuilt sandbox's tasks without an exec", async () => {
    const s = service();
    const id = await lostTask("4242", new Date(Date.now() - DAY));
    await use(s);
    expect(calls).toEqual(["create"]);
    expect(execs.filter((c) => c.includes("pkill"))).toEqual([]);
    expect(await killPending(id)).toBe(false);
  });
});
