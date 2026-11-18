import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxBrowseScope,
  type SandboxOperationScope,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ProjectKnowledgeService } from "../../src/runtime/project/knowledge.service.js";
import { type ExecutionClaim, RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PERMISSION_CONTEXT_ACTIVATION } from "../../src/sandbox/permission-context-types.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { SandboxFileReader } from "../../src/sandbox/sandbox-file-reader.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * The non-tool device callers once the one activation gate is on (permission activation L2), on
 * real admission (no mock of `SandboxService` or of the intents): a run start's project knowledge
 * read is a set of kernel reads (`withKernelRead`: the run's current claim, its run still
 * `queued`, random operation ids, the profile scope narrowed to the root's `stat`, `AGENTS.md`
 * and `.agents/skills/**`, nothing else); `agents.register-skill`'s file read is a managed
 * operation of its tool call; a device's project picker starts a stopped device for its owner
 * (`ensureRunningForOwner`) before the owner browse; admission's working root falls back exactly
 * as the command review's does.
 */

const CLOUD = "@kernel-reads-test";
const WS = DEFAULT_SANDBOX_ROOTS.workspace;
const APP = `${WS}/app`;

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
let root: string;

/** The device's files (the fixture keeps lifecycle only): a path → its text. */
const files = new Map<string, string>();
/** Every provider entry reached: the route, the method, the path and the operation's scope. */
const seen: {
  route: "operation" | "browse" | "raw";
  method: string;
  path: string;
  readRoots?: readonly string[];
  operationId?: string;
}[] = [];

const enc = new TextEncoder();
const statOf = (path: string) => {
  if (files.has(path)) return { size: enc.encode(files.get(path)).byteLength, isDir: false };
  for (const p of files.keys()) if (p.startsWith(`${path}/`)) return { size: 0, isDir: true };
  return null;
};
const readOf = (path: string) => {
  const text = files.get(path);
  return text === undefined ? null : { data: enc.encode(text), truncated: false };
};
const listOf = (path: string, limit: number) => {
  if (statOf(path)?.isDir !== true) return null;
  const names = new Map<string, boolean>();
  for (const p of files.keys()) {
    if (!p.startsWith(`${path}/`)) continue;
    const [first, ...rest] = p.slice(path.length + 1).split("/");
    names.set(first as string, rest.length > 0);
  }
  const entries = [...names]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, isDir]) => ({ name, isDir }));
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
};
const within = (path: string, roots: readonly string[]) =>
  roots.some((r) => path === r || path.startsWith(`${r === "/" ? "" : r}/`));

beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pg.url, redis: redis.url }, { roles: ["api"] }), {
    overrides: [{ provide: PERMISSION_CONTEXT_ACTIVATION, useValue: true }],
  });
  raw = createDb(pg.url, 5);
  root = await mkdtemp(join(tmpdir(), "kernel-reads-"));
  const base = createFakeSandbox(root);
  const record = (
    route: "operation" | "browse" | "raw",
    method: string,
    path: string,
    scope?: { readRoots: readonly string[]; operationId: string },
  ) => {
    seen.push({
      route,
      method,
      path,
      ...(scope && { readRoots: scope.readRoots, operationId: scope.operationId }),
    });
    if (scope && !within(path, scope.readRoots))
      throw new SandboxScopeDeniedError(`${path} is outside the scope`);
  };
  const scoped = (scope: SandboxOperationScope) => ({
    operationId: scope.operationId,
    readRoots: scope.filesystem.kind === "device" ? ["/"] : scope.filesystem.readRoots,
  });
  const impl: SandboxProvider = {
    ...base,
    stat: async (_h, path) => {
      record("raw", "stat", path);
      return statOf(path);
    },
    readFile: async (_h, path) => {
      record("raw", "readFile", path);
      return readOf(path);
    },
    list: async (_h, path, opts) => {
      record("raw", "list", path);
      return listOf(path, opts.limit);
    },
    scan: async (_h, b) => {
      record("raw", "scan", b);
      return [{ path: APP, suggestedName: "app" }];
    },
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: false,
      };
    },
    async revokeOperation() {},
    async operation(h, scope) {
      const s = scoped(scope);
      return {
        exec: async (args) => {
          record("operation", "exec", args.cwd ?? "", s);
          return base.exec(h, { ...args, actor: scope.actor, tag: scope.tag });
        },
        readFile: async (path) => {
          record("operation", "readFile", path, s);
          return readOf(path);
        },
        writeFile: async (path) => {
          record("operation", "writeFile", path, s);
        },
        stat: async (path) => {
          record("operation", "stat", path, s);
          return statOf(path);
        },
        list: async (path, opts) => {
          record("operation", "list", path, s);
          return listOf(path, opts.limit);
        },
        scan: async (b) => {
          record("operation", "scan", b, s);
          return [];
        },
      };
    },
    async browse(_h, scope: SandboxBrowseScope) {
      const s = { operationId: scope.operationId, readRoots: scope.readRoots };
      return {
        stat: async (path) => {
          record("browse", "stat", path, s);
          return statOf(path);
        },
        list: async (path, opts) => {
          record("browse", "list", path, s);
          return listOf(path, opts.limit);
        },
        scan: async (b) => {
          record("browse", "scan", b, s);
          return [{ path: APP, suggestedName: "app" }];
        },
      };
    },
  };
  k.app.get(SandboxProviders).register({ plugin: CLOUD, version: "v1", impl });
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  seen.length = 0;
  files.clear();
  files.set(`${APP}/AGENTS.md`, "Be kind to the build.");
  files.set(
    `${APP}/.agents/skills/fix/SKILL.md`,
    "---\nname: fix\ndescription: Fixes the build.\n---\nRun the fixer.\n",
  );
  files.set(`${APP}/secret.txt`, "do not read");
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
});

/** One org, its owner, a cloud device and a root conversation on it (no instance yet). */
async function seed(opts: { accountId?: string; orgId?: string } = {}) {
  const db = kernelDb(raw);
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const s = opts.accountId ? null : await seedConversation(raw as any);
  const accountId = opts.accountId ?? (s?.accountId as string);
  const orgId = opts.orgId ?? (s?.orgId as string);
  if (s)
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: accountId, role: "owner" })
      .execute();
  let conversationId = s?.conversationId;
  if (!conversationId) {
    const agentId = randomUUID();
    conversationId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  }
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      source: "cloud",
      provider: CLOUD,
      name: "Cloud",
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId, permission_profile: "request-approval" })
    .where("id", "=", conversationId)
    .execute();
  return { db, orgId, accountId, conversationId, deviceId };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

/** Binds the conversation to the project `app` at `path` (the fixture writes the binding). */
async function bindProject(f: Fixture, path = APP): Promise<void> {
  await f.db
    .insertInto("device_projects")
    .values({ device_id: f.deviceId, name: "app", path, created_by: f.accountId })
    .execute();
  await sql`UPDATE capybara.conversations SET project_name = 'app', project_path = ${path}
    WHERE id = ${f.conversationId}`.execute(raw);
}

/** A run of the conversation in `status`, claimed under a fresh execution. */
async function claimRun(
  f: Fixture,
  status: "queued" | "running" = "queued",
): Promise<{ runId: string; claim: ExecutionClaim }> {
  const runId = randomUUID();
  await f.db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: f.conversationId,
      trigger_account_id: f.accountId,
      status,
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  const claim = await k.app.get(RunExecution).claim(f.conversationId, runId, randomUUID());
  if (!claim) throw new Error("the run could not be claimed");
  return { runId, claim };
}

/** The run start's knowledge read under the run's real claim fence, as the run worker runs it. */
async function recordKnowledge(f: Fixture, run: { runId: string; claim: ExecutionClaim }) {
  return k.app.get(RunExecution).withClaim(
    run.claim,
    () => true,
    () =>
      k.app.get(ProjectKnowledgeService).record({
        orgId: f.orgId,
        conversationId: f.conversationId,
        runId: run.runId,
        kind: "chat",
        signal: new AbortController().signal,
      }),
  );
}

const latestProjectRoot = async (conversationId: string) =>
  (await k.app.get(EventLog).latestOfType(conversationId, "project_root"))?.payload;

const intentsOf = (f: Fixture) =>
  f.db
    .selectFrom("sandbox_operation_intents")
    .select(["operation_id", "run_id", "call_id", "method", "state", "scope"])
    .where("device_id", "=", f.deviceId)
    .orderBy("created_at")
    .execute();

describe("a run start's project knowledge read (withKernelRead)", () => {
  it("reads AGENTS.md and the skills through narrow kernel reads under the queued run's claim", async () => {
    const f = await seed();
    await bindProject(f);
    const run = await claimRun(f);
    expect(await recordKnowledge(f, run)).toBe(true);
    expect(await latestProjectRoot(f.conversationId)).toMatchObject({
      project: "app",
      root: APP,
      agentsMd: "Be kind to the build.",
      skills: [{ name: "fix", description: "Fixes the build." }],
    });
    const ops = seen.filter((s) => s.route !== "raw");
    // every device read was an admitted operation; nothing else under the root was asked
    expect(seen.filter((s) => s.route === "raw")).toEqual([]);
    expect(ops.length).toBeGreaterThanOrEqual(4);
    expect(ops.every((s) => s.route === "operation")).toBe(true);
    expect(ops.every((s) => ["stat", "readFile", "list"].includes(s.method))).toBe(true);
    expect(ops.some((s) => s.path.endsWith("secret.txt"))).toBe(false);
    // each operation's only read root is the narrowest one covering its path
    for (const s of ops) {
      const expected =
        s.path === APP
          ? APP
          : s.path === `${APP}/AGENTS.md`
            ? `${APP}/AGENTS.md`
            : `${APP}/.agents/skills`;
      expect(s.readRoots).toEqual([expected]);
    }
    // random operation ids, each recorded with the run for audit and no tool call identity
    const intents = await intentsOf(f);
    expect(intents).toHaveLength(ops.length);
    expect(new Set(intents.map((r) => r.operation_id)).size).toBe(intents.length);
    for (const r of intents) {
      expect(r).toMatchObject({ run_id: run.runId, call_id: null, state: "completed" });
      const scope = r.scope as unknown as SandboxOperationScope;
      expect(scope.filesystem).toMatchObject({ kind: "scoped", writeRoots: [] });
      expect(scope.network).toEqual({ kind: "none" });
    }
  });

  it("a retried run start reads again under new operation ids (no consumed identity)", async () => {
    const f = await seed();
    await bindProject(f);
    const run = await claimRun(f);
    await recordKnowledge(f, run);
    const first = new Set((await intentsOf(f)).map((r) => r.operation_id));
    expect(first.size).toBeGreaterThan(0);
    // the retry is a new execution of the same queued run
    const again = await k.app.get(RunExecution).claim(f.conversationId, run.runId, randomUUID());
    await recordKnowledge(f, { runId: run.runId, claim: again as ExecutionClaim });
    const all = (await intentsOf(f)).map((r) => r.operation_id);
    expect(all.length).toBe(first.size * 2);
    expect(all.filter((id) => first.has(id))).toHaveLength(first.size);
  });

  it("admits nothing once the run is running (the run start's reads are queued-only)", async () => {
    const f = await seed();
    await bindProject(f);
    const run = await claimRun(f, "running");
    expect(await recordKnowledge(f, run)).toBe(true);
    expect(await latestProjectRoot(f.conversationId)).toBeUndefined();
    expect(seen).toEqual([]);
    expect(await intentsOf(f)).toEqual([]);
  });

  it("admits nothing under a superseded execution claim", async () => {
    const f = await seed();
    await bindProject(f);
    const run = await claimRun(f);
    // another worker claimed the run meanwhile: this execution's claim is stale
    await f.db
      .updateTable("runs")
      .set({ execution_id: randomUUID() })
      .where("id", "=", run.runId)
      .execute();
    const sandbox = k.app.get(SandboxService);
    await expect(
      sandbox.withKernelRead(
        ctxOf(f, run),
        { claim: run.claim, purpose: "project_root", root: APP },
        (h, p, _info, signal) => p.stat(h, APP, signal),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(seen.filter((s) => s.route === "operation")).toEqual([]);
    expect(await intentsOf(f)).toEqual([]);
  });

  it("refuses any path, method or root outside the project's AGENTS.md and skills", async () => {
    const f = await seed();
    await bindProject(f);
    const run = await claimRun(f);
    const sandbox = k.app.get(SandboxService);
    const read = <T>(
      fn: Parameters<SandboxService["withKernelRead"]>[2],
      rootPath = APP,
    ): Promise<T> =>
      k.app.get(RunExecution).withClaim(
        run.claim,
        () => true,
        () =>
          sandbox.withKernelRead(
            ctxOf(f, run),
            { claim: run.claim, purpose: "project_root", root: rootPath },
            fn,
            new AbortController().signal,
          ),
      ) as Promise<T>;
    const signal = new AbortController().signal;
    await expect(
      read((h, p) => p.readFile(h, `${APP}/secret.txt`, { maxBytes: 9, signal })),
    ).rejects.toThrow();
    await expect(read((h, p) => p.readFile(h, APP, { maxBytes: 9, signal }))).rejects.toThrow();
    await expect(
      read(
        (h, p) =>
          p.list?.(h, APP, { limit: 9, limits: { mode: "sandbox" }, signal }) as Promise<unknown>,
      ),
    ).rejects.toThrow();
    await expect(read((h, p) => p.stat(h, `${APP}/../app/secret.txt`, signal))).rejects.toThrow();
    await expect(
      read((h, p) => p.writeFile(h, `${APP}/AGENTS.md`, enc.encode("x"), signal)),
    ).rejects.toThrow();
    await expect(
      read((h, p) => p.exec(h, { command: "true", timeoutMs: 1000, maxOutputBytes: 10, signal })),
    ).rejects.toThrow();
    // a root that is not the conversation's bound project is refused before any operation
    await expect(read((h, p) => p.stat(h, WS, signal), WS)).rejects.toThrow();
    expect(seen.filter((s) => s.route === "operation")).toEqual([]);
    // the allowed reads go through
    expect(await read((h, p) => p.stat(h, APP, signal))).toMatchObject({ isDir: true });
    expect(
      await read((h, p) => p.readFile(h, `${APP}/AGENTS.md`, { maxBytes: 99, signal })),
    ).toMatchObject({ truncated: false });
  });

  it("is reachable only from the knowledge service (no tool, Platform or HTTP caller)", async () => {
    const { readFile: read } = await import("node:fs/promises");
    const { execSync } = await import("node:child_process");
    const src = join(import.meta.dirname, "../../src");
    const callers = execSync(`grep -rl "withKernelRead" ${src}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((p) => p.slice(src.length + 1))
      .sort();
    expect(callers).toEqual(["runtime/project/knowledge.service.ts", "sandbox/sandbox.service.ts"]);
    expect(await read(join(src, "tools/builtins/sandbox/common.ts"), "utf8")).not.toContain(
      "withKernelRead",
    );
  });
});

const ctxOf = (f: Fixture, run: { runId: string }) => ({
  orgId: f.orgId,
  deviceId: f.deviceId,
  holderConversationId: f.conversationId,
  silent: true as const,
  actor: { accountId: f.accountId, conversationId: f.conversationId, runId: run.runId },
});

describe("admission's working root follows the command review's fallbacks", () => {
  const workingRoot = (f: Fixture) =>
    k.app.get(SandboxOperationAuthority).workingRootFor({
      orgId: f.orgId,
      deviceId: f.deviceId,
      conversationId: f.conversationId,
    });
  const snapshot = async (f: Fixture, rootPath: string, unavailable = false) => {
    await k.app.get(EventLog).append(f.conversationId, [
      {
        type: "project_root",
        idemKey: `test_project_root:${randomUUID()}`,
        payload: {
          project: "app",
          root: rootPath,
          skills: [],
          ...(unavailable && { unavailable: { reason: "gone", message: "It is gone." } }),
        },
      },
    ]);
  };

  it("a bound project before its first snapshot works in the workspace", async () => {
    const f = await seed();
    await bindProject(f);
    expect(await workingRoot(f)).toBe(WS);
  });

  it("a usable snapshot of the bound root makes it the working root", async () => {
    const f = await seed();
    await bindProject(f);
    await snapshot(f, APP);
    expect(await workingRoot(f)).toBe(APP);
  });

  it("an unavailable snapshot falls back to the workspace", async () => {
    const f = await seed();
    await bindProject(f);
    await snapshot(f, APP, true);
    expect(await workingRoot(f)).toBe(WS);
  });

  it("a root outside the workspace without the os-user reach falls back to the workspace", async () => {
    const f = await seed();
    // the device's narrowing switch: sandbox mode, so its reach is the workspace only
    await f.db
      .updateTable("devices")
      .set({ mode: "sandbox" })
      .where("id", "=", f.deviceId)
      .execute();
    await bindProject(f, "/srv/app");
    await snapshot(f, "/srv/app");
    expect(await workingRoot(f)).toBe(WS);
  });

  it("a snapshot naming another root than the binding never becomes the working root", async () => {
    const f = await seed();
    await bindProject(f);
    await snapshot(f, `${WS}/other`);
    expect(await workingRoot(f)).toBe(WS);
  });
});

describe("agents.register-skill's file read (a managed operation of its tool call)", () => {
  it("reads through real admission under the running run's claim and the started call", async () => {
    const f = await seed();
    files.set(`${WS}/pkg.zip`, "zip");
    const run = await claimRun(f, "running");
    const callId = randomUUID();
    await f.db
      .insertInto("conversation_events")
      .values({
        conversation_id: f.conversationId,
        run_id: run.runId,
        seq: 1,
        type: "tool_call_started",
        payload: JSON.stringify({ callId, toolKey: "Platform" }),
      })
      .execute();
    await f.db
      .updateTable("conversations")
      .set({ last_seq: 1 })
      .where("id", "=", f.conversationId)
      .execute();
    const got = await k.app.get(RunExecution).withClaim(
      run.claim,
      () => true,
      () =>
        k.app.get(SandboxFileReader).read({
          orgId: f.orgId,
          conversationId: f.conversationId,
          actorAccountId: f.accountId,
          path: `${WS}/pkg.zip`,
          maxBytes: 100,
          signal: new AbortController().signal,
          callId,
        }),
    );
    expect(new TextDecoder().decode(got)).toBe("zip");
    expect(seen.filter((s) => s.route === "raw" && s.method !== "scan")).toEqual([]);
    expect(seen.filter((s) => s.route === "operation").map((s) => s.method)).toEqual([
      "stat",
      "readFile",
    ]);
    expect((await intentsOf(f)).every((r) => r.call_id === callId)).toBe(true);
  });
});

describe("device projects over HTTP (owner browse after ensureRunningForOwner)", () => {
  it("a stopped device is started for its owner, then browsed; another member gets 404", async () => {
    const db = legacyDbFor(raw);
    const owner = await accountsFor(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
    });
    const req = await session(k, "owner");
    const orgId = await createOrg(req);
    const f = await seed({ accountId: owner.id, orgId });
    const res = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/devices/${f.deviceId}/projects/candidates`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ candidates: [{ path: APP, suggestedName: "app" }] });
    // the instance was made for the owner; the scan was an owner browse
    expect(
      await f.db
        .selectFrom("device_instances")
        .select("status")
        .where("device_id", "=", f.deviceId)
        .executeTakeFirst(),
    ).toMatchObject({ status: "running" });
    expect(seen.filter((s) => s.method === "scan").map((s) => s.route)).toEqual(["browse"]);
    // another member of the org is not the device's owner
    await accountsFor(db).createLocal({ login: "other", password: PW, displayName: "M" });
    const other = await session(k, "other");
    const otherId = (
      await f.db
        .selectFrom("accounts")
        .select("id")
        .where("display_name", "=", "M")
        .executeTakeFirstOrThrow()
    ).id;
    await f.db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: otherId, role: "member" })
      .execute();
    const refused = await other({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/devices/${f.deviceId}/projects/candidates`,
    });
    expect(refused.statusCode).toBe(404);
  });

  it("an owner browse of a device without a running instance answers device.not_running", async () => {
    const f = await seed();
    await expect(
      k.app
        .get(SandboxService)
        .withBrowse(
          { orgId: f.orgId, deviceId: f.deviceId, accountId: f.accountId },
          async (b, signal) => b.stat(WS, signal),
          new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: "device.not_running" });
  });
});
