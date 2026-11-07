import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHandle, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { SandboxLockLostError } from "../../src/sandbox/leases.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { fileStateOf } from "../../src/tools/builtins/sandbox/file-state.js";
import { sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import {
  createFakeSandbox,
  readFakeSandboxOps,
  removeFakeSandbox,
  setFakeSandboxDelays,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { type SandboxServiceDeps, sandboxServiceFor } from "../helpers/sandbox.js";

/**
 * Concurrent commands in one sandbox under shared leases (sub-agents spec §10, Task 4), on the
 * fake sandbox: shared holders overlap up to `sandbox.maxConcurrentCommands`, lifecycle changes
 * stay exclusive (writer preference), a `gone` with several holders rebuilds once, the kernel's
 * own read-modify-write of one file is serialized by a path lease (Review Focus 3 and 5).
 */

vi.setConfig({ testTimeout: 30_000 });

let pgc: TestContainer;
let rdc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let config: KernelConfig;
let root: string;
let provider: SandboxProvider;
const log = { info() {}, warn() {}, error() {} };
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const signal = () => AbortSignal.timeout(30_000);

const service = (
  p: () => SandboxProvider = () => provider,
  extra: Partial<SandboxServiceDeps> = {},
) =>
  sandboxServiceFor({
    db,
    redis,
    provider: () => ({ plugin: "sandbox-fake", impl: p() }),
    config: () => config,
    log,
    lockPollMs: 20,
    ...extra,
  });

const withCap = (n: number) => {
  config = { ...config, sandbox: { ...config.sandbox, maxConcurrentCommands: n } };
};

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 8);
  db = kernelDb(raw);
  redis = new Redis(rdc.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

let orgId: string;
let conversationId: string;
let accountId: string;
let envId: string;

beforeEach(async () => {
  await redis.flushdb();
  await truncateTables(
    raw,
    "capybara.environment_instances, capybara.environments, capybara.accounts, capybara.orgs",
  );
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  root = await mkdtemp(join(tmpdir(), "cap-sandbox-cc-"));
  provider = createFakeSandbox(root);
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
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
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  envId = randomUUID();
  await sql`INSERT INTO capybara.environments (id, org_id, owner_kind, owner_account_id, source)
    VALUES (${envId}, ${orgId}, 'personal', ${accountId}, 'cloud')`.execute(raw);
});

const ctx = () => ({
  orgId,
  environmentId: envId,
  holderConversationId: conversationId,
  actor: { accountId, conversationId },
});
const ops = async (op?: string) =>
  (await readFakeSandboxOps(root)).filter((o) => op === undefined || o[0] === op);
/** `exec <id> <tag> <startMs> <endMs>` lines of the fake's ops log. */
const execIntervals = async () =>
  (await ops("exec")).map((o) => ({ tag: o[2], start: Number(o[3]), end: Number(o[4]) }));

/** Runs one command in the sandbox through the service. */
const run = (s: SandboxService, command: string) =>
  s.withSandbox(
    ctx(),
    async (h, p, info, sig) => ({
      info,
      r: await p.exec(h, { command, timeoutMs: 20_000, maxOutputBytes: 1000, signal: sig }),
    }),
    signal(),
  );

/** All intervals pairwise overlap (every start is before every end). */
const allOverlap = (xs: { start: number; end: number }[]) =>
  Math.max(...xs.map((x) => x.start)) < Math.min(...xs.map((x) => x.end));

/**
 * A provider like sandbox-docker: the handle is the instance name (`{ id: name }`, stable across
 * rebuilds), and `create` replaces an instance of the same name.
 */
function sameNameProvider(inner: SandboxProvider): SandboxProvider {
  const byName = new Map<string, string>();
  const r = (h: SandboxHandle) => ({ id: byName.get(h.id as string) ?? "missing" });
  const killAll = inner.killAll.bind(inner);
  const killTagged = inner.killTagged.bind(inner);
  return {
    concurrentExec: true,
    createFileSystem: (a) => inner.createFileSystem(a),
    destroyFileSystem: (fs, sig) => inner.destroyFileSystem(fs, sig),
    destroyFileSystemByName: (n, sig) => inner.destroyFileSystemByName(n, sig),
    destroyByName: (n, sig) => inner.destroyByName(n, sig),
    async create(a) {
      const old = byName.get(a.name);
      if (old) await removeFakeSandbox(root, old);
      byName.set(a.name, (await inner.create(a)).id as string);
      return { id: a.name };
    },
    resume: (h, s) => inner.resume(r(h), s),
    suspend: (h, s) => inner.suspend(r(h), s),
    destroy: (h, s) => inner.destroy(r(h), s),
    exec: (h, a) => inner.exec(r(h), a),
    readFile: (h, p, o) => inner.readFile(r(h), p, o),
    writeFile: (h, p, d, s) => inner.writeFile(r(h), p, d, s),
    stat: (h, p, s) => inner.stat(r(h), p, s),
    killAll: (h, s) => killAll(r(h), s),
    killTagged: (h, t, s) => killTagged(r(h), t, s),
  };
}

describe("concurrent commands (fake sandbox)", () => {
  it("three held-open commands overlap (ops log intervals)", async () => {
    withCap(3);
    const s = service();
    await run(s, "true");
    await Promise.all([0, 1, 2].map(() => run(s, "sleep 0.6")));
    const xs = (await execIntervals()).slice(1);
    expect(xs).toHaveLength(3);
    expect(allOverlap(xs)).toBe(true);
    // every command carries its own holder tag
    expect(new Set(xs.map((x) => x.tag)).size).toBe(3);
  });

  it("a fourth waits and runs when one ends", async () => {
    withCap(3);
    const s = service();
    await run(s, "true");
    await setFakeSandboxDelays(root, { exec: 500 });
    await Promise.all([0, 1, 2, 3].map(() => run(s, "true")));
    const xs = (await execIntervals()).slice(1).sort((a, b) => a.start - b.start);
    expect(xs).toHaveLength(4);
    expect(allOverlap(xs.slice(0, 3))).toBe(true);
    const fourth = xs[3] as { start: number };
    expect(fourth.start).toBeGreaterThanOrEqual(Math.min(...xs.slice(0, 3).map((x) => x.end)));
  });

  it("rebuild after removeFakeSandbox waits for shared leases and is not starved (intent)", async () => {
    withCap(3);
    const s = service();
    const first = await run(s, "true");
    // A holds a shared lease with a command running
    const a = run(s, "sleep 0.8").then(() => Date.now());
    await new Promise((r) => setTimeout(r, 150));
    expect(first.info.fresh).toBe(true);
    await removeFakeSandbox(root, (await ops("create"))[0]?.[1] as string);
    // B finds the instance gone and needs the exclusive lease to rebuild
    const b = run(s, "echo b");
    await new Promise((r) => setTimeout(r, 150));
    // C arrives while B waits: the intent keeps it out until B has rebuilt
    let cEntered = 0;
    const c = s.withSandbox(
      ctx(),
      async (_h, _p, info) => {
        cEntered = Date.now();
        return info;
      },
      signal(),
    );
    const [aEnded, rb, ci] = await Promise.all([a, b, c]);
    expect(rb.info).toEqual({ fresh: true, restarted: true });
    expect(rb.r.stdout).toBe("b\n");
    expect(cEntered).toBeGreaterThanOrEqual(aEnded - 50);
    expect(ci.restarted).toBe(false);
    expect(await ops("create")).toHaveLength(2);
  });

  it("gone with three running holders rebuilds once and all three see restarted", async () => {
    withCap(3);
    const s = service();
    const first = await run(s, "true");
    expect(first.info.fresh).toBe(true);
    const id = (await ops("create"))[0]?.[1] as string;
    let entered = 0;
    let allIn!: () => void;
    const together = new Promise<void>((r) => {
      allIn = r;
    });
    const holder = () =>
      s.withSandbox(
        ctx(),
        async (h, p, info, sig) => {
          if (!info.restarted) {
            if (++entered === 3) {
              await removeFakeSandbox(root, id);
              allIn();
            }
            await together;
          }
          await p.stat(h, "/workspace", sig);
          return { info, h };
        },
        signal(),
      );
    const out = await Promise.all([holder(), holder(), holder()]);
    for (const o of out) expect(o.info).toEqual({ fresh: true, restarted: true });
    expect(new Set(out.map((o) => o.h.id)).size).toBe(1);
    expect(out[0]?.h.id).not.toBe(id);
    expect(await ops("create")).toHaveLength(2);
  });

  it("gone with three holders on a provider whose handle is the instance name rebuilds once", async () => {
    withCap(3);
    // Docker-like: handle = { id: name }, and create replaces an instance of the same name
    const named = sameNameProvider(provider);
    const s = service(() => named);
    await run(s, "true");
    const id = (await ops("create"))[0]?.[1] as string;
    let entered = 0;
    let allIn!: () => void;
    const together = new Promise<void>((r) => {
      allIn = r;
    });
    const holder = (i: number) =>
      s.withSandbox(
        ctx(),
        async (h, p, info, sig) => {
          if (!info.restarted) {
            if (++entered === 3) {
              await removeFakeSandbox(root, id);
              allIn();
            }
            await together;
          }
          await p.writeFile(h, `/workspace/f${i}`, Buffer.from(`${i}`), sig);
          await p.exec(h, {
            command: "sleep 0.3",
            timeoutMs: 5000,
            maxOutputBytes: 100,
            signal: sig,
          });
          return info;
        },
        signal(),
      );
    const out = await Promise.all([0, 1, 2].map(holder));
    for (const info of out) expect(info).toEqual({ fresh: true, restarted: true });
    expect(await ops("create")).toHaveLength(2);
    expect(await ops("destroy")).toHaveLength(0);
    // no holder's file was wiped by a second rebuild, and a later use is not "restarted"
    const after = await s.withSandbox(
      ctx(),
      async (h, p, info, sig) => ({
        info,
        files: await Promise.all(
          [0, 1, 2].map(async (i) => {
            const f = await p.readFile(h, `/workspace/f${i}`, { maxBytes: 100, signal: sig });
            return f ? Buffer.from(f.data).toString() : null;
          }),
        ),
      }),
      signal(),
    );
    expect(after.info).toEqual({ fresh: false, restarted: false });
    expect(after.files).toEqual(["0", "1", "2"]);
  });

  it("Review Focus 5: a suspended sandbox and three simultaneous first commands: one resume, then all three run", async () => {
    withCap(6);
    const s = service();
    await run(s, "true");
    expect(await s.suspendIdle(later(11 * MIN))).toBe(1);
    await setFakeSandboxDelays(root, { resume: 300 });
    const out = await Promise.all([0, 1, 2].map(() => run(s, "sleep 0.4")));
    for (const o of out) {
      expect(o.info).toEqual({ fresh: false, restarted: false });
      expect(o.r.exitCode).toBe(0);
    }
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("kill-all")).toHaveLength(1);
    const xs = (await execIntervals()).slice(1);
    expect(allOverlap(xs)).toBe(true);
  });

  it("three simultaneous first uses create one sandbox and run concurrently", async () => {
    withCap(6);
    const s = service();
    await setFakeSandboxDelays(root, { create: 200 });
    const out = await Promise.all([0, 1, 2].map(() => run(s, "sleep 0.4")));
    expect(out.filter((o) => o.info.fresh)).toHaveLength(1);
    expect(await ops("create")).toHaveLength(1);
    expect(allOverlap(await execIntervals())).toBe(true);
  });

  it("Review Focus 3: with one holder the ops sequence equals today's", async () => {
    const s = service();
    await run(s, "true");
    await run(s, "true");
    await s.withSandbox(ctx(), async (h, p, _i, sig) => p.stat(h, "/workspace", sig), signal());
    expect((await ops()).map((o) => o[0])).toEqual(["create-fs", "create", "exec", "exec"]);
    // no lease key is left; only the holder's last-seen instance (final review m5), with a TTL
    const seen = `capk:sandbox-seen:${envId}:${conversationId}`;
    expect(await redis.keys("capk:*")).toEqual([seen]);
    expect(await redis.ttl(seen)).toBeGreaterThan(0);
  });

  it("the environment's keys carry TTLs while held", async () => {
    const s = service();
    const keys = await s.withSandbox(
      ctx(),
      async () => {
        const ks = await redis.keys("capk:*");
        return Promise.all(ks.map(async (k) => [k, await redis.pttl(k)] as const));
      },
      signal(),
    );
    expect(keys.map(([k]) => k).sort()).toEqual(
      [
        `capk:sandbox-holders:${envId}`,
        // the instance this holder last used (final review m5)
        `capk:sandbox-seen:${envId}:${conversationId}`,
        `capk:sandbox-users:${envId}`,
        `capk:sandbox:${envId}`,
      ].sort(),
    );
    for (const [k, ttl] of keys) expect(ttl, k).toBeGreaterThan(0);
  });

  it("a dead holder's tag is killed by the next shared acquirer, a live sibling is not", async () => {
    withCap(3);
    const s = service();
    const { info } = await run(s, "true");
    expect(info.fresh).toBe(true);
    const id = (await ops("create"))[0]?.[1] as string;
    // a crashed holder: a tagged command still running, its holder record left behind, no lease
    const dead = randomUUID();
    const left = provider.exec(
      { id },
      {
        command: "sleep 30",
        timeoutMs: 60_000,
        maxOutputBytes: 10,
        signal: signal(),
        tag: dead,
        actor: ctx().actor,
      },
    );
    await redis.hset(`capk:sandbox-holders:${envId}`, dead, Date.now() + 600_000);
    await redis.pexpire(`capk:sandbox-holders:${envId}`, 600_000);
    const sibling = run(s, "sleep 1");
    await new Promise((r) => setTimeout(r, 200));
    const r = await run(s, "echo ok");
    expect(r.r.stdout).toBe("ok\n");
    expect(await left).toMatchObject({ exitCode: null });
    expect((await sibling).r.exitCode).toBe(0);
    const kills = await ops("kill-tagged");
    expect(kills).toEqual([["kill-tagged", id, dead]]);
    expect(await ops("kill-all")).toHaveLength(0);
  });

  it("with cap 1 a dead holder is killed by tag, never killAll", async () => {
    withCap(1);
    const s = service();
    await run(s, "true");
    const id = (await ops("create"))[0]?.[1] as string;
    const dead = randomUUID();
    await redis.hset(`capk:sandbox-holders:${envId}`, dead, Date.now() + 600_000);
    await redis.pexpire(`capk:sandbox-holders:${envId}`, 600_000);
    await run(s, "true");
    expect(await ops("kill-tagged")).toEqual([["kill-tagged", id, dead]]);
    expect(await ops("kill-all")).toHaveLength(0);
  });

  it("resume from suspended kills leftovers once", async () => {
    withCap(3);
    const s = service();
    await run(s, "true");
    const id = (await ops("create"))[0]?.[1] as string;
    // a crashed holder: its tagged command still runs, its record is left, its lease is gone
    const dead = randomUUID();
    const left = provider.exec(
      { id },
      {
        command: "sleep 30",
        timeoutMs: 60_000,
        maxOutputBytes: 10,
        signal: signal(),
        tag: dead,
        actor: ctx().actor,
      },
    );
    await redis.hset(`capk:sandbox-holders:${envId}`, dead, Date.now() + 600_000);
    await redis.pexpire(`capk:sandbox-holders:${envId}`, 600_000);
    // the sweep gets the exclusive lease (no live lease) and suspends
    expect(await s.suspendIdle(later(11 * MIN))).toBe(1);
    // three holders arrive at once: one resumes under the exclusive lease and kills everything
    // before it downgrades; the dead holder's record is claimed then, so nobody kills it by tag
    const out = await Promise.all([0, 1, 2].map(() => run(s, "echo ok")));
    for (const o of out) expect(o.r.stdout).toBe("ok\n");
    expect(await ops("resume")).toHaveLength(1);
    expect(await ops("kill-all")).toEqual([["kill-all", id]]);
    expect(await ops("kill-tagged")).toHaveLength(0);
    expect(await left).toMatchObject({ exitCode: null });
    expect(await redis.hkeys(`capk:sandbox-holders:${envId}`)).toEqual([]);
    // later uses of the running instance kill nothing more
    await run(s, "true");
    expect(await ops("kill-all")).toHaveLength(1);
    expect(await ops("kill-tagged")).toHaveLength(0);
  });

  it("every tagged exec refreshes the holder's record", async () => {
    const s = service();
    await run(s, "true");
    const key = `capk:sandbox-holders:${envId}`;
    const seen = await s.withSandbox(
      ctx(),
      async (h, p, _i, sig) => {
        const [token] = await redis.hkeys(key);
        await redis.hdel(key, token as string);
        await p.exec(h, { command: "true", timeoutMs: 5000, maxOutputBytes: 10, signal: sig });
        return redis.hkeys(key);
      },
      signal(),
    );
    expect(seen).toHaveLength(1);
    expect(await redis.exists(key)).toBe(0);
  });

  it("maxRunningMinutes: the sweep's intent lets the suspension in when running commands end", async () => {
    withCap(3);
    const s = service();
    await run(s, "true");
    await sql`UPDATE capybara.environment_instances SET running_since = now() - interval '3 hours'`.execute(
      raw,
    );
    const busy = run(s, "sleep 0.1");
    await new Promise((r) => setTimeout(r, 30));
    expect(await s.suspendIdle(new Date())).toBe(1);
    await busy;
    expect(await ops("suspend")).toHaveLength(1);
  });
});

describe("path leases in the sandbox tools", () => {
  const callCtx = (): BuiltinCallContext =>
    ({
      orgId,
      accountId: "a",
      agentId: "g",
      conversationId,
      callId: randomUUID(),
      signal: signal(),
    }) as BuiltinCallContext;

  const tools = (s: SandboxService) =>
    sandboxTools({
      sandbox: s,
      // biome-ignore lint/suspicious/noExplicitAny: only lists attachments
      attachments: { listForConversation: async () => [] } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not called
      storage: {} as any,
      // The log is not under test here (path leases are): report the file as read and unchanged by
      // returning its live state. read-before-write.test.ts covers the rule itself.
      // only latestFileState is called
      eventLog: {
        append: async () => [],
        latestFileState: async (_conv: string, path: string) =>
          s.withSandbox(
            ctx(),
            async (h, p, _i, sig) => {
              const st = await p.stat(h, path, sig);
              const got = await p.readFile(h, path, { maxBytes: 1 << 20, signal: sig });
              return st && got ? fileStateOf(got.data, st.size) : null;
            },
            signal(),
          ),
      },
      config: { get: () => config },
    });
  const tool = (s: SandboxService, name: string) =>
    tools(s).find((t) => t.spec.name === name) as BuiltinTool;

  it("two Edit calls on one file both apply", async () => {
    withCap(3);
    // a slow read widens the read-modify-write window: without the path lease one edit is lost
    const slow: SandboxProvider = {
      ...provider,
      readFile: async (h, path, o) => {
        await new Promise((r) => setTimeout(r, 200));
        return provider.readFile(h, path, o);
      },
    };
    const s = service(() => slow);
    await tool(s, "Write").run({ file_path: "/workspace/f.txt", content: "a\nb\n" }, callCtx());
    const edit = tool(s, "Edit");
    await Promise.all([
      edit.run({ file_path: "/workspace/f.txt", old_string: "a\n", new_string: "A\n" }, callCtx()),
      edit.run({ file_path: "/workspace/f.txt", old_string: "b\n", new_string: "B\n" }, callCtx()),
    ]);
    const got = await s.withSandbox(
      ctx(),
      (h, p, _i, sig) => p.readFile(h, "/workspace/f.txt", { maxBytes: 100, signal: sig }),
      signal(),
    );
    expect(new TextDecoder().decode(got?.data)).toBe("A\nB\n");
  });

  it("attachments already synced: a call reads the marker and takes no path lease", async () => {
    const s = service();
    const leased: string[] = [];
    const pathLease = s.pathLease.bind(s);
    s.pathLease = (conv, path, sig) => {
      leased.push(path);
      return pathLease(conv, path, sig);
    };
    const t = sandboxTools({
      sandbox: s,
      attachments: {
        listForConversation: async () => [{ id: "a1", name: "data.csv" }],
        openForConversation: async () => ({
          name: "data.csv",
          contentType: "text/csv",
          size: 2,
          body: new Response("ok").body,
        }),
        // biome-ignore lint/suspicious/noExplicitAny: test double
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not called
      storage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: not called
      eventLog: {} as any,
      config: { get: () => config },
    }).find((x) => x.spec.name === "Bash") as BuiltinTool;
    await t.run({ command: "true" }, callCtx());
    expect(leased).toEqual(["/workspace/attachments/.capybara-sync.json"]);
    await t.run({ command: "true" }, callCtx());
    await t.run({ command: "true" }, callCtx());
    expect(leased).toHaveLength(1);
  });

  it("a lost path lease aborts the write it guards", async () => {
    const s = service();
    await run(s, "true");
    s.pathLease = async () => {
      const ctl = new AbortController();
      ctl.abort(new SandboxLockLostError(conversationId));
      return { signal: ctl.signal, release: async () => {} };
    };
    await expect(
      tool(s, "Write").run({ file_path: "/workspace/lost.txt", content: "x" }, callCtx()),
    ).rejects.toThrow(/lock was lost/);
    const st = await s.withSandbox(
      ctx(),
      (h, p, _i, sig) => p.stat(h, "/workspace/lost.txt", sig),
      signal(),
    );
    expect(st).toBeNull();
  });

  it("the path lease uses the sandbox conversation", async () => {
    withCap(3);
    const s = service();
    const child = {
      ...callCtx(),
      conversationId: randomUUID(),
      sandboxConversationId: conversationId,
    };
    await tool(s, "Write").run({ file_path: "/workspace/g.txt", content: "x" }, child);
    // the child's call used the parent's sandbox: one instance, the file is there
    const out = await run(s, "cat /workspace/g.txt");
    expect(out.r.stdout).toBe("x");
    expect(await ops("create")).toHaveLength(1);
  });
});
