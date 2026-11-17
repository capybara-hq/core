import { randomUUID } from "node:crypto";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { PermissionProfilesService } from "../../src/conversations/permission-profiles.service.js";
import { createDb } from "../../src/db/pool.js";
import {
  runOutsideTransaction,
  TransactionHost,
} from "../../src/infra/database/transaction-host.js";
import { LocalInstanceBindings } from "../../src/local-devices/instance-bindings.js";
import { createLogger } from "../../src/log.js";
import {
  permissionContextIdemKey,
  permissionContextText,
} from "../../src/runtime/context/permission-profile.js";
import { RunError } from "../../src/runtime/model-call.js";
import {
  PERMISSION_CONTEXT_RUN_ERRORS,
  PermissionContextRecorder,
} from "../../src/runtime/permission-context.service.js";
import { ExecutionRevoked, RunExecution } from "../../src/runtime/run-execution.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import { PermissionConfigPublication } from "../../src/sandbox/permission-config-publication.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { PermissionRuntimeReports } from "../../src/sandbox/permission-runtime-reports.js";
import { PermissionTransitions } from "../../src/sandbox/permission-transitions.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { gate, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import {
  type ContextFixture,
  contexts,
  identityFor,
  inputOf,
  type ReportKind,
  ROOTS,
  recordUnder,
  seedContext,
  seedTask,
  seedTaskRun,
  spyProvider,
  startRun,
} from "./permission-context-fixture.js";

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
let provider: ReturnType<typeof spyProvider>;
const lifecycle: string[] = [];
let armed = false;

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
  provider = spyProvider(k);
});
afterAll(async () => {
  provider?.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  provider.calls.length = 0;
  lifecycle.length = 0;
  // F3: while a context is recorded, no live permission, review, admission, grant, report,
  // approval, provisioning or device entrypoint may run (the reader only reads facts)
  const targets: [object, string[]][] = [
    [
      k.app.get(SandboxOperationAuthority),
      ["previewCall", "resolve", "resolveInvocation", "resolveBrowse", "subjectFor"],
    ],
    [k.app.get(SandboxOperationIntents), ["pending", "admit", "admitBrowse", "claimDispatch"]],
    [k.app.get(CommandReviewService), ["review"]],
    [
      k.app.get(PermissionCallGrants),
      ["issueLocked", "findForAdmission", "forExecution", "assertCurrent"],
    ],
    [k.app.get(PermissionRuntimeReports), ["record"]],
    [k.app.get(LocalInstanceBindings), ["bind", "install", "retarget"]],
    [
      k.app.get(ApprovalsService),
      ["request", "requestNetwork", "requestGit", "requestCommand", "decide"],
    ],
    [
      k.app.get(SandboxService),
      [
        "withSandbox",
        "withOperations",
        "withPreparation",
        "withBrowse",
        "ifRunning",
        "status",
        "currentInstance",
        "availableFor",
        "pathLease",
        "destroyDevice",
        "resetFileSystem",
        "ensure",
      ],
    ],
  ];
  for (const [target, methods] of targets)
    for (const m of methods) {
      const fn = (target as Record<string, unknown>)[m];
      if (typeof fn !== "function") throw new Error(`no live entrypoint ${m} to spy on`);
      const original = (fn as (...a: unknown[]) => unknown).bind(target);
      vi.spyOn(target as Record<string, (...a: unknown[]) => unknown>, m).mockImplementation(
        (...args: unknown[]) => {
          if (!armed) return original(...args);
          lifecycle.push(m);
          throw new Error(`a permission context read called the live entrypoint ${m}`);
        },
      );
    }
  const recorder = k.app.get(PermissionContextRecorder);
  const recordOriginal = recorder.record.bind(recorder);
  vi.spyOn(recorder, "record").mockImplementation(async (input, s) => {
    armed = true;
    try {
      return await recordOriginal(input, s);
    } finally {
      armed = false;
    }
  });
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.device_instance_bindings, capybara.device_permission_reports, capybara.device_generation_high_water",
  );
});
afterEach(() => {
  expect(provider.calls).toEqual([]);
  expect(lifecycle).toEqual([]);
});

const signal = () => new AbortController().signal;
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a recorded permission context");
  return value;
};
const record = (f: ContextFixture) => recordUnder(k, f.claim, inputOf(f));
const runErrorCode = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RunError);
  return (error as RunError).code;
};
const scopeRevisionOf = async (f: ContextFixture) =>
  (await k.app.get(PermissionFacts).scope(f.orgId, f.deviceId, null, null)).scopeRevision;

describe("recorded permission context recorder", () => {
  it("records the supported restricted base authority under a real claim once, then dedupes", async () => {
    const f = await seedContext(k, raw);
    const notify = vi.spyOn(k.app.get(EventLog), "notify");
    await record(f);
    const [first, ...rest] = await contexts(raw, f.rootId);
    expect(rest).toEqual([]);
    expect(first?.runId).toBe(f.runId);
    expect(first?.payload).toEqual({
      version: 1,
      rootConversationId: f.rootId,
      profileRevision: 0,
      selectedProfile: "request-approval",
      effectiveProfile: "request-approval",
      execution: "interactive",
      inherited: false,
      deviceId: f.deviceId,
      scopeRevision: await scopeRevisionOf(f),
      authorityRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      availability: { state: "supported" },
      scope: {
        location: "local",
        workingRoot: "/work",
        filesystem: { kind: "scoped", readDirectories: ["/work"], writeDirectories: ["/work"] },
        network: { kind: "none" },
        outerNetwork: { kind: "host-environment" },
      },
    });
    expect(first?.idemKey).toBe(permissionContextIdemKey(must(first).payload, 0));
    expect(notify).toHaveBeenCalledWith(f.rootId, first?.seq);
    // the base rights equal what admission resolves for a new operation of this run
    const admitted = await k.app.get(SandboxOperationAuthority).resolve(
      {
        orgId: f.orgId,
        deviceId: f.deviceId,
        holderConversationId: f.rootId,
        actor: { accountId: f.accountId, conversationId: f.rootId, runId: f.runId },
      },
      "exec",
      signal(),
    );
    expect(admitted.filesystem).toEqual({
      kind: "scoped",
      readRoots: ["/work"],
      writeRoots: ["/work"],
    });
    expect(admitted.network).toEqual({ kind: "none" });
    expect(admitted.ceilingRevision).toBe(first?.payload.authorityRevision);
    // unchanged facts: no extra event, no notification
    notify.mockClear();
    await record(f);
    expect(await contexts(raw, f.rootId)).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("appends profile changes A to B to A from the persisted log and restricted-only authority changes", async () => {
    const f = await seedContext(k, raw);
    const profiles = k.app.get(PermissionProfilesService);
    await record(f);
    await profiles.set(f.orgId, f.rootId, f.accountId, {
      profile: "approve-for-me",
      expectedRevision: 0,
    });
    await record(f);
    await profiles.set(f.orgId, f.rootId, f.accountId, {
      profile: "request-approval",
      expectedRevision: 1,
    });
    await record(f);
    let events = await contexts(raw, f.rootId);
    expect(events.map((e) => [e.payload.selectedProfile, e.payload.profileRevision])).toEqual([
      ["request-approval", 0],
      ["approve-for-me", 1],
      ["request-approval", 2],
    ]);
    expect(events[2]?.idemKey).toBe(
      permissionContextIdemKey(must(events[2]).payload, must(events[1]).seq),
    );
    // a restricted-only device authority change: same scope, new authority revision
    await k.app.get(TransactionHost).run(async () => {
      const subject = { orgId: f.orgId, deviceId: f.deviceId };
      await k.app.get(PermissionAuthorityLock).acquire(subject, { kind: "write", level: "device" });
      const epochs = k.app.get(PermissionAuthorityEpochStore);
      const vector = await epochs.readLocked(subject);
      await epochs.bumpLocked("device", f.deviceId, vector.device ?? 0);
    });
    await record(f);
    events = await contexts(raw, f.rootId);
    expect(events).toHaveLength(4);
    expect(events[3]?.payload.scope).toEqual(events[2]?.payload.scope);
    expect(events[3]?.payload.scopeRevision).toBe(events[2]?.payload.scopeRevision);
    expect(events[3]?.payload.authorityRevision).not.toBe(events[2]?.payload.authorityRevision);
  });

  it("a profile change records a new context without touching an admitted task's starting grant or claiming it stopped", async () => {
    const f = await seedContext(k, raw);
    await record(f);
    const taskId = randomUUID();
    await f.db
      .insertInto("background_tasks")
      .values({
        id: taskId,
        org_id: f.orgId,
        conversation_id: f.rootId,
        sandbox_conversation_id: f.rootId,
        run_id: f.runId,
        call_id: randomUUID(),
        trigger_account_id: f.accountId,
        description: "tests",
        command: "pnpm test",
        output_path: "/tmp/out",
        deadline_at: new Date(Date.now() + 3_600_000),
        device_id: f.deviceId,
        profile_revision: 0,
        working_root: "/work",
        network_authority: JSON.stringify({ hosts: [], source: { kind: "base" } }),
      } as never)
      .execute();
    const task = () =>
      f.db.selectFrom("background_tasks").selectAll().where("id", "=", taskId).executeTakeFirst();
    const before = await task();
    await k.app.get(PermissionProfilesService).set(f.orgId, f.rootId, f.accountId, {
      profile: "approve-for-me",
      expectedRevision: 0,
    });
    await record(f);
    const events = await contexts(raw, f.rootId);
    expect(events.map((e) => e.payload.effectiveProfile)).toEqual([
      "request-approval",
      "approve-for-me",
    ]);
    // the started task keeps its starting grant, revision and state; nothing says it stopped
    expect(await task()).toEqual(before);
    expect(before?.status).toBe("running");
    const text = permissionContextText(events[1]?.payload as never);
    expect(text).toContain("Work already started keeps its starting permissions.");
    expect(text).not.toMatch(/\bstopped\b/);
  });

  it("rolls back an append whose transaction fails and notifies nothing", async () => {
    const f = await seedContext(k, raw);
    const log = k.app.get(EventLog);
    const append = log.appendIn.bind(log);
    const notify = vi.spyOn(log, "notify");
    const spy = vi.spyOn(log, "appendIn").mockImplementationOnce(async (id, events) => {
      await append(id, events);
      throw new Error("injected failure after the append");
    });
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.invalid.code);
    expect(await contexts(raw, f.rootId)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    spy.mockRestore();
    await record(f);
    const [event] = await contexts(raw, f.rootId);
    expect(event?.idemKey).toBe(permissionContextIdemKey(must(event).payload, 0));
  });

  it("refuses without the run's inherited claim, for another run's claim and for a replay conversation", async () => {
    const f = await seedContext(k, raw);
    const recorder = k.app.get(PermissionContextRecorder);
    expect(await runErrorCode(recorder.record(inputOf(f), signal()))).toBe(
      PERMISSION_CONTEXT_RUN_ERRORS.invalid.code,
    );
    const other = await seedContext(k, raw);
    expect(await runErrorCode(recordUnder(k, other.claim, inputOf(f)))).toBe(
      PERMISSION_CONTEXT_RUN_ERRORS.invalid.code,
    );
    expect(
      await runErrorCode(
        k.app.get(TransactionHost).run(() =>
          k.app.get(RunExecution).withClaim(
            f.claim,
            () => true,
            () => recorder.record(inputOf(f), signal()),
          ),
        ),
      ),
    ).toBe(PERMISSION_CONTEXT_RUN_ERRORS.invalid.code);
    // the claim identity without its fence (left through runOutsideTransaction) after the claim was
    // replaced: refused before any lock (the fence is required), nothing written
    const replaced = await seedContext(k, raw);
    await k.app.get(RunExecution).claim(replaced.rootId, replaced.runId, randomUUID());
    expect(
      await runErrorCode(
        k.app.get(RunExecution).withClaim(
          replaced.claim,
          () => true,
          () => runOutsideTransaction(() => recorder.record(inputOf(replaced), signal())),
        ),
      ),
    ).toEqual(expect.any(String));
    expect(await contexts(raw, replaced.rootId)).toEqual([]);
    await f.db
      .updateTable("conversations")
      .set({ kind: "eval" })
      .where("id", "=", f.rootId)
      .execute();
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.invalid.code);
    expect(await contexts(raw, f.rootId)).toEqual([]);
    // a child whose own row looks ordinary but whose root is a replay conversation refuses too
    // (the guard covers the whole tree, independent of whether replays dispatch children)
    const tree = await seedContext(k, raw);
    const child = randomUUID();
    await tree.db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: tree.orgId,
        agent_id: tree.agentId,
        account_id: tree.accountId,
        kind: "subagent",
        parent_conversation_id: tree.rootId,
      } as never)
      .execute();
    await tree.db
      .updateTable("conversations")
      .set({ kind: "eval" })
      .where("id", "=", tree.rootId)
      .execute();
    const childRun = await startRun(k, raw, child, tree.accountId);
    expect(
      await runErrorCode(
        recordUnder(k, childRun.claim, {
          orgId: tree.orgId,
          conversationId: child,
          runId: childRun.runId,
          accountId: tree.accountId,
        }),
      ),
    ).toBe(PERMISSION_CONTEXT_RUN_ERRORS.invalid.code);
    expect(await contexts(raw, child)).toEqual([]);
  });

  it("refuses a claimed record without the run's inherited fence and appends nothing", async () => {
    const f = await seedContext(k, raw);
    const error = await k.app
      .get(RunExecution)
      .withClaim(
        f.claim,
        () => true,
        () =>
          // the claim stays in context, the fence does not
          runOutsideTransaction(() =>
            k.app.get(PermissionContextRecorder).record(inputOf(f), signal()),
          ),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RunError);
    expect(await contexts(raw, f.rootId)).toEqual([]);
  });

  it("a replaced claim, an ended or deleted run and an abort append nothing and keep their identity", async () => {
    const f = await seedContext(k, raw);
    const replaced = await k.app.get(RunExecution).claim(f.rootId, f.runId, randomUUID());
    expect(replaced).not.toBeNull();
    await expect(record(f)).rejects.toBeInstanceOf(ExecutionRevoked);
    // the claim fence passes (same execution id) but the run ended: the recorder's own comparison
    const g = await seedContext(k, raw);
    await g.db.updateTable("runs").set({ status: "completed" }).where("id", "=", g.runId).execute();
    await expect(record(g)).rejects.toBeInstanceOf(ExecutionRevoked);
    const h = await seedContext(k, raw);
    await h.db
      .updateTable("conversations")
      .set({ deleted_at: new Date() })
      .where("id", "=", h.rootId)
      .execute();
    await expect(record(h)).rejects.toBeInstanceOf(ExecutionRevoked);
    const i = await seedContext(k, raw);
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    await expect(recordUnder(k, i.claim, inputOf(i), controller.signal)).rejects.toBe(reason);
    for (const x of [f, g, h, i]) expect(await contexts(raw, x.rootId)).toEqual([]);
  });

  it("maps a stale publication, an inactive actor and a corrupt recorded snapshot to named no-send errors", async () => {
    const f = await seedContext(k, raw);
    const publication = k.app.get(PermissionConfigPublication);
    vi.spyOn(publication, "assertCurrent").mockRejectedValueOnce(
      new SandboxScopeDeniedError(
        "This replica has not applied the current permission configuration",
      ),
    );
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.stale.code);
    await f.db
      .updateTable("accounts")
      .set({ status: "disabled" })
      .where("id", "=", f.accountId)
      .execute();
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.actor.code);
    await f.db
      .updateTable("accounts")
      .set({ status: "active" })
      .where("id", "=", f.accountId)
      .execute();
    // F5: a recorded snapshot the strict v1 schema rejects is invalid, never overwritten silently
    await f.db
      .insertInto("conversation_events")
      .values({
        conversation_id: f.rootId,
        seq: 1,
        type: "permission_context",
        payload: JSON.stringify({ version: 2 }),
      })
      .execute();
    await f.db
      .updateTable("conversations")
      .set({ last_seq: 1 })
      .where("id", "=", f.rootId)
      .execute();
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.invalid.code);
    expect((await contexts(raw, f.rootId)).map((e) => e.seq)).toEqual([1]);
  });

  it("rediscovers once when the device changed during discovery, and fails a second change", async () => {
    const f = await seedContext(k, raw);
    const g = await seedContext(k, raw);
    // g's device moves to f's org so f's root can be rebound to it
    await f.db
      .updateTable("devices")
      .set({ org_id: f.orgId, owner_account_id: f.accountId, name: "Desk" })
      .where("id", "=", g.deviceId)
      .execute();
    await f.db
      .updateTable("device_machines")
      .set({ org_id: f.orgId, account_id: f.accountId })
      .where("device_id", "=", g.deviceId)
      .execute();
    await f.db
      .updateTable("device_instances")
      .set({ org_id: f.orgId })
      .where("device_id", "=", g.deviceId)
      .execute();
    const locks = k.app.get(PermissionAuthorityLock);
    const acquire = locks.acquire.bind(locks);
    const subjects: (string | undefined)[] = [];
    let rebinds = 1;
    vi.spyOn(locks, "acquire").mockImplementation(async (subject, intent) => {
      if (subject.rootConversationId === f.rootId && intent.kind === "admit") {
        subjects.push(subject.deviceId);
        if (rebinds-- > 0)
          // a binding writer wins between discovery and the locks
          await raw
            .withSchema("capybara")
            .updateTable("conversations" as never)
            .set({ device_id: g.deviceId } as never)
            .where("id" as never, "=", f.rootId as never)
            .execute();
      }
      return acquire(subject, intent);
    });
    await record(f);
    expect(subjects).toEqual([f.deviceId, g.deviceId]);
    const [event, ...more] = await contexts(raw, f.rootId);
    expect(more).toEqual([]);
    expect(event?.payload.deviceId).toBe(g.deviceId);
    // two changes in a row: the run fails with the named error and nothing is appended
    rebinds = 2;
    subjects.length = 0;
    let flip = f.deviceId;
    vi.spyOn(locks, "acquire").mockImplementation(async (subject, intent) => {
      if (subject.rootConversationId === f.rootId && intent.kind === "admit") {
        subjects.push(subject.deviceId);
        await raw
          .withSchema("capybara")
          .updateTable("conversations" as never)
          .set({ device_id: flip } as never)
          .where("id" as never, "=", f.rootId as never)
          .execute();
        flip = flip === f.deviceId ? g.deviceId : f.deviceId;
      }
      return acquire(subject, intent);
    });
    expect(await runErrorCode(record(f))).toBe(PERMISSION_CONTEXT_RUN_ERRORS.changed.code);
    expect(subjects).toHaveLength(2);
    expect(await contexts(raw, f.rootId)).toHaveLength(1);
  });

  it.each(["writer-first", "recorder-first"] as const)(
    "an authority writer and the recorder complete in fixed order (%s)",
    async (order) => {
      const f = await seedContext(k, raw);
      const profiles = k.app.get(PermissionProfilesService);
      const waiting = () =>
        waitFor(
          async () => {
            const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(raw);
            return (r.rows[0]?.n ?? 0) > 0;
          },
          10_000,
          "a transaction waiting on the other's lock",
        );
      const held = gate(),
        entered = gate();
      if (order === "writer-first") {
        const transitions = k.app.get(PermissionTransitions);
        const original = transitions.recordLocked.bind(transitions);
        vi.spyOn(transitions, "recordLocked").mockImplementationOnce(async (...args) => {
          entered.open();
          await held.promise;
          return original(...args);
        });
        const writer = profiles.set(f.orgId, f.rootId, f.accountId, {
          profile: "approve-for-me",
          expectedRevision: 0,
        });
        await entered.promise;
        const recorder = record(f);
        await waiting();
        held.open();
        await Promise.all([writer, recorder]);
        const events = await contexts(raw, f.rootId);
        expect(events.map((e) => e.payload.profileRevision)).toEqual([1]);
      } else {
        const authority = k.app.get(SandboxOperationAuthority);
        const read = authority.readContextLocked.bind(authority);
        vi.spyOn(authority, "readContextLocked").mockImplementationOnce(async (input, s) => {
          const payload = await read(input, s);
          entered.open();
          await held.promise;
          return payload;
        });
        const recorder = record(f);
        await entered.promise;
        const writer = profiles.set(f.orgId, f.rootId, f.accountId, {
          profile: "approve-for-me",
          expectedRevision: 0,
        });
        await waiting();
        held.open();
        await Promise.all([writer, recorder]);
        await record(f);
        const events = await contexts(raw, f.rootId);
        expect(events.map((e) => e.payload.profileRevision)).toEqual([0, 1]);
      }
    },
  );
});

describe("permission context projection", () => {
  it("no device and a nonowner actor are unavailable with exact null fields and no owner scope", async () => {
    const none = await seedContext(k, raw, { device: false });
    await record(none);
    expect((await contexts(raw, none.rootId))[0]?.payload).toEqual({
      version: 1,
      rootConversationId: none.rootId,
      profileRevision: 0,
      selectedProfile: "request-approval",
      effectiveProfile: null,
      execution: "interactive",
      inherited: false,
      deviceId: null,
      scopeRevision: null,
      authorityRevision: null,
      availability: {
        state: "unavailable",
        cause: "no-device",
        reason: "Choose a device to run device operations",
      },
      scope: null,
    });
    const foreign = await seedContext(k, raw, { foreignDevice: true, profile: "full-access" });
    await record(foreign);
    expect((await contexts(raw, foreign.rootId))[0]?.payload).toEqual({
      version: 1,
      rootConversationId: foreign.rootId,
      profileRevision: null,
      selectedProfile: null,
      effectiveProfile: null,
      execution: "interactive",
      inherited: false,
      deviceId: null,
      scopeRevision: null,
      authorityRevision: null,
      availability: {
        state: "unavailable",
        cause: "actor-device-access",
        reason: "This run's actor cannot use the selected device",
      },
      scope: null,
    });
  });

  const unprobed = { state: "unprobed", reason: expect.any(String) };
  it.each<[string, Parameters<typeof seedContext>[2], (f: ContextFixture) => Promise<void>]>([
    ["no runtime report", { report: null }, async () => {}],
    ["a binding still awaiting the device", { binding: "awaiting" }, async () => {}],
    ["no binding of this generation", { binding: "none" }, async () => {}],
    [
      "a suspended instance without its binding",
      { status: "suspended", binding: "none" },
      async () => {},
    ],
    [
      "a stale runtime identity",
      {},
      async (f) => {
        await f.db
          .updateTable("device_instances")
          .set({ permission_runtime_identity: JSON.stringify(identityFor(f.generation, "d")) })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
    ],
    [
      "an installed binding of a replaced machine",
      {},
      async (f) => {
        await f.db
          .updateTable("device_instance_bindings")
          .set({ machine_id: randomUUID() })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
    ],
    [
      // 9.3 M3: every cloud device is unprobed today (no installed cloud evidence, B-15), so this
      // case proves only that; the desired/applied distinction for cloud gets its own case with H1
      "a cloud device is unprobed until its binding evidence exists",
      {},
      async (f) => {
        await f.db
          .updateTable("devices")
          .set({
            source: "cloud",
            outer_network: JSON.stringify({ kind: "allowlist", hosts: [] }),
          })
          .where("id", "=", f.deviceId)
          .execute();
        await f.db
          .updateTable("device_instances")
          .set({
            instance_limits: JSON.stringify({
              mode: "sandbox",
              network: { kind: "open-public", hosts: [] },
              unapplied: { mode: "sandbox", network: { kind: "allowlist", hosts: [] } },
            }),
          })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
    ],
  ])("%s is unprobed without scope and calls no provider", async (_name, seed, mutate) => {
    const f = await seedContext(k, raw, seed);
    await mutate(f);
    await record(f);
    const [event] = await contexts(raw, f.rootId);
    expect(event?.payload).toMatchObject({
      effectiveProfile: "request-approval",
      deviceId: f.deviceId,
      availability: unprobed,
      scope: null,
    });
    expect(event?.payload.scopeRevision).toEqual(expect.any(String));
    expect(event?.payload.authorityRevision).toEqual(expect.any(String));
  });

  it("a suspended instance with its installed evidence is supported without a resume", async () => {
    const f = await seedContext(k, raw, { status: "suspended" });
    await record(f);
    expect((await contexts(raw, f.rootId))[0]?.payload.availability).toEqual({
      state: "supported",
    });
  });

  it("a provider without the permission contract is unsupported", async () => {
    const f = await seedContext(k, raw);
    const unsupported = spyProvider(k, { contract: false });
    try {
      await record(f);
    } finally {
      unsupported.restore();
      provider = spyProvider(k);
    }
    expect((await contexts(raw, f.rootId))[0]?.payload).toMatchObject({
      availability: { state: "unsupported" },
      scope: null,
    });
  });

  // effective profile x report: supported only when the report supports exactly that profile
  const matrix: [
    "request-approval" | "approve-for-me" | "full-access",
    boolean | undefined,
    ReportKind,
    string,
  ][] = [];
  for (const report of ["both", "restricted-only", "full-only", "neither"] as const) {
    matrix.push(
      [
        "request-approval",
        undefined,
        report,
        report === "both" || report === "restricted-only" ? "supported" : "unsupported",
      ],
      [
        "approve-for-me",
        undefined,
        report,
        report === "both" || report === "restricted-only" ? "supported" : "unsupported",
      ],
      [
        "full-access",
        true,
        report,
        report === "both" || report === "full-only" ? "supported" : "unsupported",
      ],
      // stale Full consent evaluates Approve for me: a Full-only runtime is then unsupported
      [
        "full-access",
        false,
        report,
        report === "both" || report === "restricted-only" ? "supported" : "unsupported",
      ],
    );
  }
  it.each(matrix)(
    "%s (consent %s) on a %s report is %s",
    async (profile, consent, report, state) => {
      const f = await seedContext(k, raw, { profile, consent, report });
      await record(f);
      const payload = (await contexts(raw, f.rootId))[0]?.payload;
      expect(payload?.selectedProfile).toBe(profile);
      // view keeps Full only with a current consent and a runtime not explicitly unsupported
      expect(payload?.effectiveProfile).toBe(
        profile === "full-access" && (consent === false || report === "neither")
          ? "approve-for-me"
          : profile,
      );
      expect(payload?.availability.state).toBe(state);
      if (state === "supported" && payload?.effectiveProfile === "full-access")
        expect(payload.scope).toEqual({
          location: "local",
          workingRoot: "/work",
          filesystem: { kind: "device" },
          network: { kind: "environment" },
          outerNetwork: { kind: "host-environment" },
        });
      if (state !== "supported") expect(payload?.scope).toBeNull();
    },
  );

  // B-16: admission reads the same applied environment and runtime verdict as the recorded context,
  // so a context without scope always matches a refused admission with the same reason (narrowing
  // only: admission never admits what the model is told it cannot do, and vice versa)
  const toCloud = (unapplied: boolean) => async (f: ContextFixture) => {
    await f.db
      .updateTable("devices")
      .set({ source: "cloud", outer_network: JSON.stringify({ kind: "allowlist", hosts: [] }) })
      .where("id", "=", f.deviceId)
      .execute();
    await f.db
      .updateTable("device_instances")
      .set({
        instance_limits: JSON.stringify({
          mode: "sandbox",
          network: unapplied
            ? { kind: "open-public", hosts: [] }
            : { kind: "allowlist", hosts: [] },
          ...(unapplied && {
            unapplied: { mode: "sandbox", network: { kind: "allowlist", hosts: [] } },
          }),
        }),
      })
      .where("device_id", "=", f.deviceId)
      .execute();
  };
  it.each<
    [
      string,
      Parameters<typeof seedContext>[2],
      ((f: ContextFixture) => Promise<void>) | null,
      "supported" | "unsupported" | "unprobed",
      // the one named exception: cloud admission enforces neither the runtime report nor the
      // applied environment until installed cloud evidence exists (B-15; W2-H1 flips these cases
      // to refused)
      "cloud-admits-until-B-15"?,
    ]
  >([
    ["local applied, restricted", {}, null, "supported"],
    ["local applied, Full with consent", { profile: "full-access" }, null, "supported"],
    ["local applied, suspended", { status: "suspended" }, null, "supported"],
    ["local without a runtime report", { report: null }, null, "unprobed"],
    ["local restricted on a Full-only runtime", { report: "full-only" }, null, "unsupported"],
    [
      "local whose provider is no longer available",
      {},
      async (f) => {
        await f.db
          .updateTable("devices")
          .set({ provider: "@no-such-provider" })
          .where("id", "=", f.deviceId)
          .execute();
      },
      "unsupported",
    ],
    // the unproved environment precedes the capability report in both readers
    [
      "local restricted on a Full-only runtime without a binding",
      { report: "full-only", binding: "none" },
      null,
      "unprobed",
    ],
    ["local desired but unapplied: binding awaiting", { binding: "awaiting" }, null, "unprobed"],
    ["local desired but unapplied: no binding", { binding: "none" }, null, "unprobed"],
    [
      "local stale: runtime identity replaced",
      {},
      async (f) => {
        await f.db
          .updateTable("device_instances")
          .set({ permission_runtime_identity: JSON.stringify(identityFor(f.generation, "d")) })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
      "unprobed",
    ],
    [
      "local stale: binding of a replaced machine",
      {},
      async (f) => {
        await f.db
          .updateTable("device_instance_bindings")
          .set({ machine_id: randomUUID() })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
      "unprobed",
    ],
    [
      "local stale: committed roots differ from the instance's",
      {},
      async (f) => {
        await f.db
          .updateTable("device_instances")
          .set({ permission_roots: JSON.stringify({ ...ROOTS, workspace: "/old" }) })
          .where("device_id", "=", f.deviceId)
          .execute();
      },
      "unprobed",
    ],
    [
      "cloud applied, without installed evidence",
      {},
      toCloud(false),
      "unprobed",
      "cloud-admits-until-B-15",
    ],
    ["cloud desired but unapplied", {}, toCloud(true), "unprobed", "cloud-admits-until-B-15"],
    [
      "cloud without a runtime report",
      { report: null },
      toCloud(false),
      "unprobed",
      "cloud-admits-until-B-15",
    ],
  ])("context and admission agree: %s", async (_name, seed, mutate, state, exception) => {
    const f = await seedContext(k, raw, seed);
    await mutate?.(f);
    await record(f);
    const payload = must((await contexts(raw, f.rootId))[0]).payload;
    expect(payload.availability.state).toBe(state);
    const admission = await k.app
      .get(SandboxOperationAuthority)
      .resolve(
        {
          orgId: f.orgId,
          deviceId: f.deviceId,
          holderConversationId: f.rootId,
          actor: { accountId: f.accountId, conversationId: f.rootId, runId: f.runId },
        },
        "exec",
        signal(),
      )
      .then(
        () => ({ admitted: true as const }),
        (e: unknown) => ({ refused: e instanceof Error ? e.message : String(e) }),
      );
    if (payload.availability.state === "supported" || exception)
      expect(admission).toEqual({ admitted: true });
    else expect(admission).toEqual({ refused: payload.availability.reason });
  });

  it.each([
    ["removed from the org", "membership"],
    ["disabled", "account"],
  ] as const)("an actor %s gets no context and no admission, with one reason", async (_n, what) => {
    const f = await seedContext(k, raw);
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
    // the context is no-send (no event); admission refuses on the same first predicate (the
    // owned root of an active member, `readOwnedRoot`), and its actor check backs it under the locks
    expect(await runErrorCode(record(f))).toEqual(expect.any(String));
    expect(await contexts(raw, f.rootId)).toEqual([]);
    await expect(
      k.app.get(SandboxOperationAuthority).resolve(
        {
          orgId: f.orgId,
          deviceId: f.deviceId,
          holderConversationId: f.rootId,
          actor: { accountId: f.accountId, conversationId: f.rootId, runId: f.runId },
        },
        "exec",
        signal(),
      ),
    ).rejects.toMatchObject({ code: "conversation.not_found" });
  });

  it("scheduled roots, children and wakes evaluate Request approval with the actual task grants", async () => {
    // a scheduled root on a Full-only runtime: Request approval, unsupported
    const scheduledRoot = await seedContext(k, raw, {
      scheduledRoot: true,
      profile: "full-access",
      report: "full-only",
    });
    await record(scheduledRoot);
    expect((await contexts(raw, scheduledRoot.rootId))[0]?.payload).toMatchObject({
      execution: "scheduled",
      selectedProfile: "full-access",
      effectiveProfile: "request-approval",
      availability: { state: "unsupported" },
      scope: null,
    });
    // an interactive Full root whose child run serves a scheduled task run (a wake or a child)
    const f = await seedContext(k, raw, { profile: "full-access" });
    const taskId = await seedTask(f.db, f, ["api.example.com"]);
    const taskRun = await seedTaskRun(f.db, f.orgId, taskId);
    const child = randomUUID();
    await f.db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: f.orgId,
        agent_id: f.agentId,
        account_id: f.accountId,
        kind: "subagent",
        parent_conversation_id: f.rootId,
      } as never)
      .execute();
    const run = await startRun(k, raw, child, f.accountId, taskRun);
    const input = {
      orgId: f.orgId,
      conversationId: child,
      runId: run.runId,
      accountId: f.accountId,
    };
    await recordUnder(k, run.claim, input);
    const [event] = await contexts(raw, child);
    expect(event?.runId).toBe(run.runId);
    expect(event?.payload).toMatchObject({
      rootConversationId: f.rootId,
      inherited: true,
      execution: "scheduled",
      selectedProfile: "full-access",
      effectiveProfile: "request-approval",
      availability: { state: "supported" },
      scope: {
        filesystem: { kind: "scoped", readDirectories: ["/work"], writeDirectories: ["/work"] },
        network: { kind: "allowlist", hosts: ["api.example.com"] },
      },
    });
    // the same hosts admission grants this run, and nothing in the root's own log
    const admitted = await k.app.get(SandboxOperationAuthority).resolve(
      {
        orgId: f.orgId,
        deviceId: f.deviceId,
        holderConversationId: child,
        actor: { accountId: f.accountId, conversationId: child, runId: run.runId },
      },
      "exec",
      signal(),
    );
    expect(admitted.network).toEqual({ kind: "allowlist", hosts: ["api.example.com"] });
    expect(await contexts(raw, f.rootId)).toEqual([]);
    // the interactive root run itself keeps Full and no task hosts
    await record(f);
    expect((await contexts(raw, f.rootId))[0]?.payload.scope?.network).toEqual({
      kind: "environment",
    });
  });

  it("an explicit task grant outside the device network ceiling is narrowed exactly as admission narrows it", async () => {
    const f = await seedContext(k, raw);
    const taskId = await seedTask(f.db, f, ["api.example.com", "blocked.example.org"]);
    const taskRun = await seedTaskRun(f.db, f.orgId, taskId);
    await f.db.updateTable("runs").set({ status: "completed" }).where("id", "=", f.runId).execute();
    const run = await startRun(k, raw, f.rootId, f.accountId, taskRun);
    // the platform and org ceiling of this device allows only api.example.com
    const facts = k.app.get(PermissionFacts);
    const policy = facts.devicePolicy.bind(facts);
    vi.spyOn(facts, "devicePolicy").mockImplementation(async (device) => ({
      ...(await policy(device)),
      network: { kind: "allowlist", hosts: ["api.example.com"] },
    }));
    await recordUnder(k, run.claim, { ...inputOf(f), runId: run.runId });
    const admitted = await k.app.get(SandboxOperationAuthority).resolve(
      {
        orgId: f.orgId,
        deviceId: f.deviceId,
        holderConversationId: f.rootId,
        actor: { accountId: f.accountId, conversationId: f.rootId, runId: run.runId },
      },
      "exec",
      signal(),
    );
    const [event] = await contexts(raw, f.rootId);
    expect(event?.payload.execution).toBe("scheduled");
    expect(event?.payload.scope?.network).toEqual({
      kind: "allowlist",
      hosts: ["api.example.com"],
    });
    expect(admitted.network).toEqual(event?.payload.scope?.network);
  });

  it("the applied environment adapter needs the device authority lock", async () => {
    const f = await seedContext(k, raw);
    await record(f);
    // the adapter refuses without the device authority lock
    await expect(
      k.app
        .get(TransactionHost)
        .run(() =>
          k.app
            .get(PermissionFacts)
            .readAppliedEnvironmentLocked({ orgId: f.orgId, deviceId: f.deviceId }),
        ),
    ).rejects.toThrow("The matching authority lock is required");
  });
});
