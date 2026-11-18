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
import { sandboxLeasesFor, sandboxServiceFor, seedDevice } from "../helpers/sandbox.js";
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
let envId: string;
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
  w.killAll = (h, s) => {
    calls.push("killAll");
    return impl.killAll(h, s);
  };
  w.killTagged = (h, t, s) => {
    calls.push("killTagged");
    return impl.killTagged(h, t, s);
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
});

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.device_instances, capybara.devices, capybara.accounts, capybara.orgs",
  );
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
  envId = await seedDevice(raw, seed.orgId, seed.accountId);
});

/** The device of the sandbox (the lease key). */
const env = () => envId;
const conv = () => seed.conversationId;
const actor = () => ({ accountId: seed.accountId, conversationId: conv() });
const use = (s: SandboxService) =>
  s.withSandbox(
    { orgId: seed.orgId, deviceId: env(), holderConversationId: conv(), actor: actor() },
    async (h) => h,
    signal(),
  );
const row = () =>
  db.selectFrom("device_instances").selectAll().where("device_id", "=", env()).executeTakeFirst();

/** A finished task of the device's instance marked `kill_pending`. */
async function lostTask(sid: string, sandboxCreatedAt: Date): Promise<string> {
  const id = `bt_${randomUUID().slice(0, 6)}`;
  await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
      sandbox_conversation_id, device_id, run_id, call_id, trigger_account_id, description, command, sid,
      output_path, status, lost_reason, finished_at, deadline_at, sandbox_created_at, kill_pending)
    VALUES (${id}, ${seed.orgId}, ${conv()}, ${conv()}, ${env()}, 'run-1', 'call-1', ${seed.accountId},
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
    expect(await s.currentInstance(env())).toBeNull();
    await use(s);
    const r = await row();
    expect(await s.currentInstance(env())).toEqual({
      createdAt: r?.created_at,
      provider: "sandbox-fake",
    });
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    expect(await s.currentInstance(env())).toEqual({
      createdAt: r?.created_at,
      provider: "sandbox-fake",
    });
    await s.destroyInactive(new Date(Date.now() + 30 * DAY));
    expect(await s.currentInstance(env())).toBeNull();
  });
});

describe("ifRunning", () => {
  it("returns not_running without a sandbox and never creates one", async () => {
    const s = service();
    let ran = false;
    const r = await s.ifRunning(env(), { createdAt: new Date() }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "not_running", status: "gone" });
    expect(ran).toBe(false);
    expect(await row()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("on a suspended sandbox returns not_running, leaves it suspended, creates and resumes nothing", async () => {
    const s = service();
    const h = await use(s);
    const instance = await s.currentInstance(env());
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    calls = [];
    execs = [];
    let ran = false;
    const r = await s.ifRunning(env(), instance as { createdAt: Date }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "not_running", status: "suspended" });
    expect(ran).toBe(false);
    expect((await row())?.status).toBe("suspended");
    expect(await fakeSandboxState(root, h.id)).toBe("suspended");
    expect(calls).toEqual([]);
    expect(execs).toEqual([]);
    expect((await readFakeSandboxOps(root)).filter((o) => o[0] === "autostart")).toEqual([]);
  });

  it("on a destroyed sandbox returns not_running with the row's status", async () => {
    const s = service();
    await use(s);
    const instance = await s.currentInstance(env());
    await s.destroyInactive(new Date(Date.now() + 30 * DAY));
    let ran = false;
    const r = await s.ifRunning(env(), instance as { createdAt: Date }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "not_running", status: "destroyed" });
    expect(ran).toBe(false);
  });

  it("with a stale createdAt returns other_instance and does not run fn", async () => {
    const s = service();
    await use(s);
    const instance = await s.currentInstance(env());
    const stale = new Date((instance?.createdAt.getTime() ?? 0) - 60_000);
    let ran = false;
    const r = await s.ifRunning(env(), { createdAt: stale }, async () => {
      ran = true;
    });
    expect(r).toEqual({ kind: "other_instance" });
    expect(ran).toBe(false);
  });

  it("on the running instance runs fn under a shared lease (tagged execs) and refreshes last_used_at", async () => {
    const s = service();
    const h = await use(s);
    const instance = await s.currentInstance(env());
    const old = new Date(Date.now() - DAY);
    await db
      .updateTable("device_instances")
      .set({ last_used_at: old })
      .where("device_id", "=", env())
      .execute();
    const leases = sandboxLeasesFor({ redis, log: {} });
    calls = [];
    const r = await s.ifRunning(env(), instance as { createdAt: Date }, async (p, handle, sig) => {
      expect(handle).toEqual(h);
      // an exclusive lease (a suspension, a resume) cannot get in while fn runs
      expect(await leases.tryExclusive(env())).toBeNull();
      const out = await p.exec(handle, {
        command: "echo ok",
        timeoutMs: 5000,
        maxOutputBytes: 100,
        signal: sig,
        actor: actor(),
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
    const ex = await leases.tryExclusive(env());
    expect(ex).not.toBeNull();
    await ex?.release();
  });
});

describe("ifRunning with a signal", () => {
  it("gives up waiting for the lease promptly when the signal aborts", async () => {
    const s = service();
    await use(s);
    const instance = (await s.currentInstance(env())) as { createdAt: Date };
    const leases = sandboxLeasesFor({ redis, log: {} });
    const held = await leases.tryExclusive(env());
    expect(held).not.toBeNull();
    try {
      const ac = new AbortController();
      let ran = false;
      const t0 = Date.now();
      const pending = s.ifRunning(
        env(),
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

describe("no SID cleanup after a resume or a rebuild (permission runtime cutover B-1)", () => {
  it("a resume signals no stored session id, runs no kill and leaves the flags to retirement", async () => {
    const s = service();
    await use(s);
    const instance = (await s.currentInstance(env())) as { createdAt: Date };
    const mine = await lostTask("4242", instance.createdAt);
    expect(await s.suspendIdle(new Date(Date.now() + DAY))).toBe(1);
    execs = [];
    await use(s);
    expect(calls).toContain("resume");
    expect(calls).not.toContain("killAll");
    expect(execs.filter((c) => /tk_kill|pkill/.test(c))).toEqual([]);
    // a stored SID is no authority: the flag is the retirement obligation's, never cleared here
    expect(await killPending(mine)).toBe(true);
  });

  it("a rebuild runs no kill exec either", async () => {
    const s = service();
    const id = await lostTask("4242", new Date(Date.now() - DAY));
    await use(s);
    expect(calls).toEqual(["create"]);
    expect(execs.filter((c) => /tk_kill|pkill/.test(c))).toEqual([]);
    expect(await killPending(id)).toBe(true);
  });
});
