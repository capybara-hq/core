import { randomUUID } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS, type SandboxProvider, ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ManagedDevicePathsV1 } from "../../src/conversations/events.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import {
  runOutsideTransaction,
  TransactionHost,
} from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { MembersService } from "../../src/orgs/members.service.js";
import {
  managedDevicePathsIdemKey,
  managedDevicePathsText,
} from "../../src/runtime/context/permission-profile.js";
import {
  type ExecutionClaim,
  ExecutionRevoked,
  RunExecution,
} from "../../src/runtime/run-execution.js";
import {
  MANAGED_DEVICE_CONTEXT_FAILED_TEXT,
  MANAGED_DEVICE_CONTEXT_STALE_TEXT,
  MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT,
  ManagedDeviceContextRecorder,
} from "../../src/sandbox/managed-device-context.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionConfigPublication } from "../../src/sandbox/permission-config-publication.js";
import { PermissionRuntimeReports } from "../../src/sandbox/permission-runtime-reports.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { managedSandboxDeps } from "../../src/tools/builtins/builtin-tools.js";
import {
  inSandbox,
  inSandboxOperations,
  type SandboxSession,
  type SandboxToolDeps,
} from "../../src/tools/builtins/sandbox/common.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { identityFor, REPORTS, startRun } from "../runtime/permission-context-fixture.js";

/**
 * Gate 9.4 / Task 8 shared writer (permission context replay spec B3): the managed device context
 * writer injected into the real `common.ts` managed route, under the real `RunExecution.withClaim`
 * fence, over a local device whose held instance has an installed binding. The writer records
 * the marked `device_paths` before any preparation or user callback, and refuses a held instance
 * whose binding or generation was replaced even when every path is identical.
 */

const PROVIDER = "@managed-context-test";
const ROOTS = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
/** What happened, in order: the writer's appends are read back at each provider step. */
const order: string[] = [];

beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
  const provider = {
    async permissionSupport() {
      return REPORTS.both;
    },
    async revokeOperation() {},
    async prepare() {
      order.push("prepare");
      return {
        async mkdir() {},
        async writeFile() {},
        async stat() {
          return null;
        },
      };
    },
    async operation() {
      throw new Error("no device operation in these cases");
    },
  } as unknown as SandboxProvider;
  k.app.get(SandboxProviders).register({ plugin: PROVIDER, version: "test-1", impl: provider });
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  order.length = 0;
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
});

/** One org, its owner, a root conversation bound to a local device with an installed binding. */
async function seed(opts: { project?: string } = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
  const s = await seedConversation(raw as any);
  const db = kernelDb(raw);
  await db
    .insertInto("memberships")
    .values({ org_id: s.orgId, account_id: s.accountId, role: "owner" })
    .execute();
  const deviceId = randomUUID();
  const generation = String(1_700_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const bindingId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: s.orgId,
      owner_kind: "personal",
      owner_account_id: s.accountId,
      source: "local",
      provider: PROVIDER,
      name: "Laptop",
    })
    .execute();
  const machineId = (
    await db
      .insertInto("device_machines")
      .values({
        org_id: s.orgId,
        device_id: deviceId,
        account_id: s.accountId,
        credential_hash: randomUUID(),
        name: "Laptop",
        os: "darwin",
        arch: "arm64",
        program_version: "0.1.0",
        features: ["mode", "projects"],
        roots: JSON.stringify(ROOTS),
        home: "/home/owner",
        local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("device_instances")
    .values({
      device_id: deviceId,
      org_id: s.orgId,
      provider: PROVIDER,
      status: "running",
      handle: JSON.stringify({ id: deviceId, roots: ROOTS }),
      permission_roots: JSON.stringify(ROOTS),
      created_at: new Date(Number(generation)),
      fs_status: "ready",
      had_instance: true,
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "open-public", hosts: [] },
      }),
    })
    .execute();
  const identity = identityFor(generation);
  await k.app.get(TransactionHost).run(async () => {
    await k.app
      .get(PermissionAuthorityLock)
      .acquire({ orgId: s.orgId, deviceId }, { kind: "write", level: "device" });
    await k.app
      .get(PermissionRuntimeReports)
      .record(deviceId, PROVIDER, "test-1", identity, REPORTS.both);
  });
  await db
    .insertInto("device_instance_bindings")
    .values({
      device_id: deviceId,
      instance_generation: generation,
      binding_id: bindingId,
      provider: PROVIDER,
      status: "installed",
      machine_id: machineId,
      runtime_identity: JSON.stringify(identity),
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId, permission_profile: "request-approval" })
    .where("id", "=", s.conversationId)
    .execute();
  if (opts.project) {
    await db
      .insertInto("device_projects")
      .values({ device_id: deviceId, name: "app", path: opts.project, created_by: s.accountId })
      .execute();
    // fixture setup writes the otherwise immutable project binding
    await sql`UPDATE capybara.conversations SET project_name = 'app',
      project_path = ${opts.project} WHERE id = ${s.conversationId}`.execute(raw);
  }
  const run = await startRun(k, raw, s.conversationId, s.accountId);
  return { ...s, db, deviceId, generation, bindingId, ...run };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const depsOf = (
  over: { [K in keyof SandboxToolDeps]?: SandboxToolDeps[K] | undefined } = {},
): SandboxToolDeps =>
  ({
    sandbox: k.app.get(SandboxService),
    devices: k.app.get(ConversationDevices),
    attachments: {
      listForConversation: async () => [],
      openForConversation: async () => {
        throw new Error("no attachments");
      },
    },
    storage: { available: () => false } as never,
    eventLog: k.app.get(EventLog),
    config: k.app.get(KernelConfigService),
    managedDeviceContext: k.app.get(ManagedDeviceContextRecorder),
    managedDeviceContextRequired: true,
    ...over,
  }) as SandboxToolDeps;
const ctxOf = (f: Fixture, claim: ExecutionClaim = f.claim): BuiltinCallContext => ({
  orgId: f.orgId,
  accountId: f.accountId,
  agentId: f.agentId,
  conversationId: f.conversationId,
  callId: randomUUID(),
  runId: f.runId,
  signal: new AbortController().signal,
  executionClaim: claim,
});

/** The managed paths events of the conversation, in order. */
async function managedPaths(f: Fixture): Promise<{ seq: number; payload: ManagedDevicePathsV1 }[]> {
  const rows = await f.db
    .selectFrom("conversation_events")
    .select(["seq", "payload"])
    .where("conversation_id", "=", f.conversationId)
    .where("type", "=", "device_paths")
    .orderBy("seq")
    .execute();
  return rows.map((r) => ({ seq: Number(r.seq), payload: r.payload as ManagedDevicePathsV1 }));
}

/** A managed call through the real `common.ts` route under the run's real claim fence. */
async function call(
  f: Fixture,
  deps: SandboxToolDeps = depsOf(),
  claim: ExecutionClaim = f.claim,
): Promise<SandboxSession> {
  const { value } = await k.app.get(RunExecution).withClaim(
    claim,
    () => true,
    () =>
      inSandboxOperations(
        deps,
        ctxOf(f, claim),
        async (s) => {
          order.push("callback");
          return s;
        },
        // a trusted preparation stage: the provider's prepare runs before the user callback
        {
          purpose: "skills",
          roots: (r) => [r.skills],
          run: async ({ p, roots, signal }) => {
            await p.stat(`${roots.skills}/probe`, signal);
          },
        },
      ),
  );
  return value;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const failure = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the managed call to fail");
};

describe("managed device context writer in the real common.ts route", () => {
  it("records the marked paths before preparation and the user callback, into the calling conversation, once", async () => {
    const f = await seed();
    const real = k.app.get(EventLog).notify.bind(k.app.get(EventLog));
    vi.spyOn(k.app.get(EventLog), "notify").mockImplementation(async (c, seq) => {
      order.push("notify");
      return real(c, seq);
    });
    const session = await call(f);
    const paths = await managedPaths(f);
    expect(paths.map((p) => p.payload)).toEqual([
      { permissionContextVersion: 1, deviceId: f.deviceId, roots: ROOTS, workingRoot: "/work" },
    ]);
    // the append committed (and its hint followed) before preparation and the user callback
    expect(order).toEqual(["notify", "prepare", "callback"]);
    expect(session.workingRoot).toBe("/work");
    const [row] = await f.db
      .selectFrom("conversation_events")
      .select(["run_id", "idem_key"])
      .where("conversation_id", "=", f.conversationId)
      .where("type", "=", "device_paths")
      .execute();
    expect(row?.run_id).toBe(f.runId);
    expect(row?.idem_key).toBe(
      managedDevicePathsIdemKey((await managedPaths(f))[0]?.payload as ManagedDevicePathsV1, 0),
    );
    // unchanged: the next managed call appends nothing
    order.length = 0;
    await call(f);
    expect(await managedPaths(f)).toHaveLength(1);
    expect(order).toEqual(["prepare", "callback"]);
  });

  it("an outside-workspace selected project is the recorded working root; the paths grant no workspace access", async () => {
    const f = await seed({ project: "/srv/app" });
    const session = await call(f);
    const [paths] = await managedPaths(f);
    expect(paths?.payload).toEqual({
      permissionContextVersion: 1,
      deviceId: f.deviceId,
      roots: ROOTS,
      workingRoot: "/srv/app",
    });
    expect(session.workingRoot).toBe("/srv/app");
    const text = managedDevicePathsText(paths?.payload as ManagedDevicePathsV1);
    expect(text).toContain('Selected working directory: "/srv/app"');
    expect(text).toContain("These paths do not grant access");
    expect(text).not.toMatch(/writ|read/i);
  });

  it("identical paths after an old-mode event still append the old-to-marked transition", async () => {
    const f = await seed();
    await k.app.get(EventLog).append(f.conversationId, [
      {
        type: "device_paths",
        payload: { roots: ROOTS, mode: "auto", allowedMode: "auto", local: true } as never,
      },
    ]);
    await call(f);
    const paths = await managedPaths(f);
    expect(paths).toHaveLength(2);
    expect(paths[0]?.payload).not.toHaveProperty("permissionContextVersion");
    expect(paths[1]?.payload.permissionContextVersion).toBe(1);
  });

  it("a binding or generation replaced between discovery and append fails before any callback, identical paths notwithstanding", async () => {
    for (const replace of ["binding", "generation"] as const) {
      const f = await seed();
      order.length = 0;
      const publication = k.app.get(PermissionConfigPublication);
      const real = publication.assertCurrent.bind(publication);
      const spy = vi.spyOn(publication, "assertCurrent").mockImplementation(async () => {
        // the held instance was entered and its evidence taken; now the binding is replaced
        // (same device, same roots) on another connection, before the writer's comparison
        const db = kernelDb(raw);
        if (replace === "binding")
          await db
            .updateTable("device_instance_bindings")
            .set({ binding_id: randomUUID() })
            .where("device_id", "=", f.deviceId)
            .execute();
        else {
          const next = String(Number(f.generation) + 1);
          await db
            .updateTable("device_instance_bindings")
            .set({ instance_generation: next })
            .where("device_id", "=", f.deviceId)
            .execute();
          await db
            .updateTable("device_instances")
            .set({ created_at: new Date(Number(next)) })
            .where("device_id", "=", f.deviceId)
            .execute();
        }
        return real();
      });
      const err = await failure(call(f));
      spy.mockRestore();
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
      expect(order).toEqual([]);
      expect(await managedPaths(f)).toEqual([]);
    }
  });

  /** Runs `between` after the held evidence was taken and before the writer records it. */
  const betweenEvidenceAndWriter = (between: (f: Fixture) => Promise<void>, f: Fixture) => {
    const recorder = k.app.get(ManagedDeviceContextRecorder);
    const real = recorder.record.bind(recorder);
    return vi.spyOn(recorder, "record").mockImplementation(async (input, held, sig) => {
      expect(held).toMatchObject({ deviceId: f.deviceId, bindingId: f.bindingId });
      await between(f);
      return real(input, held, sig);
    });
  };

  it("a binding replaced between the held evidence and the writer fails before any callback", async () => {
    const f = await seed();
    betweenEvidenceAndWriter(async () => {
      await f.db
        .updateTable("device_instance_bindings")
        .set({ binding_id: randomUUID() })
        .where("device_id", "=", f.deviceId)
        .execute();
    }, f);
    const err = await failure(call(f));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it.each([
    ["removed from the org", "membership"],
    ["disabled", "account"],
  ] as const)(
    "an actor %s after discovery is refused no-send by the writer itself",
    async (_n, what) => {
      const f = await seed();
      betweenEvidenceAndWriter(async () => {
        if (what === "membership")
          await f.db
            .deleteFrom("memberships")
            .where("org_id", "=", f.orgId)
            .where("account_id", "=", f.accountId)
            .execute();
        else
          await f.db
            .updateTable("accounts")
            .set({ status: "disabled" })
            .where("id", "=", f.accountId)
            .execute();
      }, f);
      const err = await failure(call(f));
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
      expect(order).toEqual([]);
      expect(await managedPaths(f)).toEqual([]);
    },
  );

  it("a claim revoked after the held evidence is refused by the writer's own fence", async () => {
    const f = await seed();
    betweenEvidenceAndWriter(async () => {
      await f.db
        .updateTable("runs")
        .set({ execution_id: randomUUID() })
        .where("id", "=", f.runId)
        .execute();
    }, f);
    const err = await failure(call(f));
    expect(err).toBeInstanceOf(ExecutionRevoked);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a managed call and offboarding in one org cannot deadlock: the org row precedes the permission locks", async () => {
    const f = await seed();
    const member = randomUUID();
    await f.db.insertInto("accounts").values({ id: member, display_name: "M" }).execute();
    await f.db
      .insertInto("memberships")
      .values({ org_id: f.orgId, account_id: member, role: "member" })
      .execute();
    const held = deferred();
    const release = deferred();
    const recorder = k.app.get(ManagedDeviceContextRecorder);
    const realRecord = recorder.record.bind(recorder);
    let inWriter = false;
    vi.spyOn(recorder, "record").mockImplementation(async (input, h, sig) => {
      inWriter = true;
      return realRecord(input, h, sig);
    });
    const locks = k.app.get(PermissionAuthorityLock);
    const realAcquire = locks.acquire.bind(locks);
    vi.spyOn(locks, "acquire").mockImplementation(async (subject, intent) => {
      await realAcquire(subject, intent);
      if (inWriter && intent.kind === "admit") {
        // the writer's transaction holds the permission authority locks; pause it there
        inWriter = false;
        held.resolve();
        await release.promise;
      }
    });
    const managed = call(f);
    await held.promise;
    // offboarding: org admission, the org row, then the org permission lock exclusively
    const removal = k.app.get(MembersService).remove(f.orgId, member, f.accountId);
    await expect
      .poll(async () =>
        Number(
          (
            await sql<{ n: string }>`select count(*) n from pg_locks l
              join pg_stat_activity a on a.pid = l.pid
              where not l.granted and a.datname = current_database()`.execute(raw)
          ).rows[0]?.n,
        ),
      )
      .toBeGreaterThan(0);
    release.resolve();
    const [a, b] = await Promise.allSettled([managed, removal]);
    expect(a.status === "rejected" ? String(a.reason) : "fulfilled").toBe("fulfilled");
    expect(b.status === "rejected" ? String(b.reason) : "fulfilled").toBe("fulfilled");
    expect(await managedPaths(f)).toHaveLength(1);
  });

  it("refuses a claimed call without the run's inherited fence (its org row would follow the authority locks)", async () => {
    const f = await seed();
    const err = await failure(
      k.app.get(RunExecution).withClaim(
        f.claim,
        () => true,
        () =>
          // the claim stays in context, the fence does not
          runOutsideTransaction(() =>
            inSandboxOperations(depsOf(), ctxOf(f), async () => {
              order.push("callback");
            }),
          ),
      ),
    );
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a missing writer on the activated route fails before entering, preparation or the callback", async () => {
    const f = await seed();
    const enter = vi.spyOn(k.app.get(SandboxService), "withOperations");
    const err = await failure(call(f, depsOf({ managedDeviceContext: undefined })));
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(enter).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a rolled-back append notifies nothing and runs no callback", async () => {
    const f = await seed();
    const events = k.app.get(EventLog);
    const notify = vi.spyOn(events, "notify");
    const realAppend = events.appendIn.bind(events);
    vi.spyOn(events, "appendIn").mockImplementationOnce(async (c, e) => {
      await realAppend(c, e);
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    });
    const err = await failure(call(f));
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(notify).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a failed after-commit notification never replays the append, the preparation or the callback", async () => {
    const f = await seed();
    vi.spyOn(k.app.get(EventLog), "notify").mockRejectedValue(new Error("bus down"));
    const append = vi.spyOn(k.app.get(EventLog), "appendIn");
    await call(f);
    expect(append).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["prepare", "callback"]);
    expect(await managedPaths(f)).toHaveLength(1);
  });

  it("a revoked execution keeps its identity and records nothing", async () => {
    const f = await seed();
    // another execution claims the run: this claim's writes are fenced off
    await k.app.get(RunExecution).claim(f.conversationId, f.runId, randomUUID());
    const err = await failure(call(f));
    expect(err).toBeInstanceOf(ExecutionRevoked);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("refuses outside the run's inherited claim wrapper even with plausible input", async () => {
    const f = await seed();
    const err = await failure(inSandboxOperations(depsOf(), ctxOf(f), async () => "ran"));
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("the one activation gate decides whether builtin tools pass and require the managed writer", () => {
    const recorder = k.app.get(ManagedDeviceContextRecorder);
    // production (no provider for the token): the managed route keeps the legacy writer
    expect(managedSandboxDeps(recorder, undefined)).toEqual({});
    expect(managedSandboxDeps(recorder, false)).toEqual({});
    // the gate on passes the injected writer and requires it
    expect(managedSandboxDeps(recorder, true)).toEqual({
      managedDeviceContext: recorder,
      managedDeviceContextRequired: true,
    });
  });

  it("with the gate on, a legacy sandbox route refuses before entering instead of writing old-mode paths", async () => {
    const f = await seed();
    const enter = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    const err = await failure(
      k.app.get(RunExecution).withClaim(
        f.claim,
        () => true,
        () =>
          inSandbox(depsOf(), ctxOf(f), async () => {
            order.push("callback");
          }),
      ),
    );
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(enter).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a held instance without an installed binding is unavailable, with non-retry copy, before any callback", async () => {
    const f = await seed();
    await f.db.deleteFrom("device_instance_bindings").where("device_id", "=", f.deviceId).execute();
    const err = await failure(call(f));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_UNAVAILABLE_TEXT);
    expect((err as ToolError).message).not.toMatch(/retry/i);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });

  it("a storage failure while reading the held evidence is the managed failure, not a provider error", async () => {
    const f = await seed();
    vi.spyOn(k.app.get(SandboxOperationAuthority), "workingRootFor").mockRejectedValue(
      Object.assign(new Error("connection lost"), { code: "08006" }),
    );
    const err = await failure(call(f));
    expect((err as ToolError).message).toBe(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
    expect(order).toEqual([]);
    expect(await managedPaths(f)).toEqual([]);
  });
});
