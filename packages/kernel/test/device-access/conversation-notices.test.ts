import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_SERVICE_RESTORE_MAX_AGE_MS,
  DeviceOfflineError,
  encodeConversationDeleted,
  type ToolCallContext,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  ConversationNoticeDelivery,
  NOTICE_BACKOFF_MS,
  type NoticeOutcome,
} from "../../src/device-access/conversation-notice-delivery.js";
import { CONVERSATION_NOTICE_JOB } from "../../src/device-access/conversation-notices.js";
import {
  type DeviceAccessCaller,
  DeviceAccessService,
} from "../../src/device-access/device-access.service.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import { attachCallScope } from "../../src/tools/call-scope.js";
import { echoServiceSpec } from "../fixtures/extensions/fake-device-access/index.js";
import {
  FAKE_PERMISSION_SUPPORT,
  fakeServiceStateDir,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The kernel's conversation-deleted notice to a device's services (close tabs on delete design
 * §4): owed by the deletion, delivered to each running declared service of the conversation's
 * device (the `fake-device-access` echo service, which logs the notices it gets), kept owed while
 * a service is stopped or the device has no running instance inside the restore window, and while
 * the device does not answer. The last block runs a second kernel (worker role) on the same
 * database and device root for the row lease across replicas, so the file is a container test.
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const CALLER: DeviceAccessCaller = { extension: "fake-device-access", services: ["echo"] };
const ID = "fake-device-access.echo";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** The second replica of the lease tests (started by their block). */
let b: TestKernel | undefined;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;
let delivery: ConversationNoticeDelivery;

/** One kernel with the api and worker roles on the shared database, Redis and device root. */
const replica = () =>
  startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
          FAKE_DEVICE_ACCESS,
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
      },
    ),
  );

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-conv-notices-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await replica();
  delivery = k.app.get(ConversationNoticeDelivery);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-device-access");
});

afterAll(async () => {
  await b?.close();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  conversationId: string;
  /** A second conversation of the member on the same device: it starts services after a delete. */
  liveConversationId: string;
  agentId: string;
}
let s: Setup;

/** A member with a `device-fake` device of their own and a conversation bound to it. */
beforeEach(async () => {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      name: "Box",
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify([]),
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  const liveConversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "in", [conversationId, liveConversationId])
    .execute();
  s = { accountId, req, deviceId, conversationId, liveConversationId, agentId };
});

const use = (): SandboxUseContext => ({
  orgId,
  deviceId: s.deviceId,
  holderConversationId: s.conversationId,
  actor: { accountId: s.accountId, conversationId: s.conversationId },
});

afterEach(async () => {
  vi.restoreAllMocks();
  await k.app.get(DeviceServices).stop(use(), ID, AbortSignal.timeout(30_000));
});

/** A tool call of the member's live conversation on the device. */
const callOf = (): ToolCallContext => {
  const call: ToolCallContext = {
    orgId,
    accountId: s.accountId,
    ownerAccountId: s.accountId,
    agentId: s.agentId,
    conversationId: s.liveConversationId,
    rootConversationId: s.liveConversationId,
    callId: `call-${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    signal: AbortSignal.timeout(30_000),
  };
  attachCallScope(call, {
    runId: randomUUID(),
    step: 0,
    rootConversationId: s.liveConversationId,
    unattended: false,
    agentVersion: 1,
  });
  return call;
};

/** Starts the echo service in the conversation's device (the launch review allowed). */
const startEcho = async (): Promise<void> => {
  vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
    decision: "allow",
    by: "rule",
    reason: "test",
    rule: null,
  });
  await k.app.get(DeviceAccessService).ensureService(CALLER, callOf(), echoServiceSpec());
};

const stopEcho = () => k.app.get(DeviceServices).stop(use(), ID, AbortSignal.timeout(30_000));

/** The notices the echo service logged (one body per line). */
const logged = async (): Promise<string[]> => {
  const inst = await db
    .selectFrom("device_instances")
    .select("handle")
    .where("device_id", "=", s.deviceId)
    .executeTakeFirst();
  const id = inst?.handle?.id;
  if (!id) return [];
  const text = await readFile(
    join(fakeServiceStateDir(sandboxRoot, id, ID), "notices.log"),
    "utf8",
  ).catch(() => "");
  return text.split("\n").filter((l) => l !== "");
};

const body = (conversationId: string) =>
  new TextDecoder().decode(encodeConversationDeleted(conversationId));

const notices = (conversationId = s.conversationId) =>
  db
    .selectFrom("device_conversation_notices")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .execute();

/** The real attempt (a test's spy on `attempt` holds back only the prompt job). */
const realAttempt = ConversationNoticeDelivery.prototype.attempt;

/**
 * Deletes the conversation. With `holdJob`, the prompt notice job is held back (its attempt
 * answers `skipped`) and awaited, so the test drives every attempt itself.
 */
const deleteConv = async (opts: { holdJob?: boolean } = {}): Promise<void> => {
  const held = opts.holdJob ? vi.spyOn(delivery, "attempt").mockResolvedValue("skipped") : null;
  const res = await s.req({
    method: "DELETE",
    url: `/api/v1/orgs/${orgId}/conversations/${s.conversationId}`,
  });
  expect(res.statusCode, res.body).toBe(204);
  if (held) {
    await waitFor(async () => held.mock.calls.length > 0, 10_000, "the prompt notice job");
    held.mockRestore();
  }
};

/** One attempt now (the row's turn and lease ignored by moving them back). */
const attemptNow = async (): Promise<string> => {
  const [row] = await notices();
  if (!row) throw new Error("no notice owed");
  await db
    .updateTable("device_conversation_notices")
    .set({ next_attempt_at: sql<Date>`now()`, claimed_until: null })
    .where("id", "=", row.id)
    .execute();
  return realAttempt.call(delivery, orgId, row.id);
};

/** Ages the owed notice past the restore window. */
const ageNotice = () =>
  db
    .updateTable("device_conversation_notices")
    .set({
      created_at: sql<Date>`now() - ${DEVICE_SERVICE_RESTORE_MAX_AGE_MS + 1000}::integer * interval '1 millisecond'`,
    })
    .where("conversation_id", "=", s.conversationId)
    .execute();

describe("conversation-deleted notice", () => {
  it("is owed by the deletion with its outbox job and delivered to the running service", async () => {
    await startEcho();
    await deleteConv();
    // the prompt job delivers it: the service got the kernel's body once, the row is gone
    await waitFor(async () => (await logged()).length === 1 && (await notices()).length === 0);
    expect(await logged()).toEqual([body(s.conversationId)]);
    const owed = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", CONVERSATION_NOTICE_JOB)
      .execute();
    // the outbox row was delivered (deleted), never left dead
    expect(owed).toEqual([]);
  });

  it("owes nothing for a conversation without a device", async () => {
    await db
      .updateTable("conversations")
      .set({ device_id: null })
      .where("id", "=", s.conversationId)
      .execute();
    await deleteConv();
    expect(await notices()).toEqual([]);
  });

  it("keeps the notice owed while the service is stopped inside the restore window", async () => {
    await startEcho();
    await stopEcho();
    await deleteConv({ holdJob: true });
    expect(await notices()).toHaveLength(1);
    expect(await attemptNow()).toBe("owed");
    const [row] = await notices();
    expect(row?.acked_services).toEqual([]);
    expect(row?.last_failure).toBeNull();
    expect(row?.claimed_until).toBeNull();
    // the service runs again within the window: the next attempt delivers
    await startEcho();
    expect(await attemptNow()).toBe("delivered");
    expect(await logged()).toEqual([body(s.conversationId)]);
    expect(await notices()).toEqual([]);
  });

  it("settles a notice whose service stayed stopped once the restore window has passed", async () => {
    await startEcho();
    await stopEcho();
    await deleteConv({ holdJob: true });
    expect(await attemptNow()).toBe("owed");
    await ageNotice();
    expect(await attemptNow()).toBe("delivered");
    expect(await logged()).toEqual([]);
    expect(await notices()).toEqual([]);
  });

  it("keeps it owed without a running instance until the window has passed", async () => {
    // no instance at all: never created, resumed or started for the notice
    await deleteConv({ holdJob: true });
    expect(await attemptNow()).toBe("owed");
    expect(
      await db
        .selectFrom("device_instances")
        .select("status")
        .where("device_id", "=", s.deviceId)
        .execute(),
    ).toEqual([]);
    await ageNotice();
    expect(await attemptNow()).toBe("delivered");
  });

  it("keeps it owed with a backoff while the device does not answer, whatever the window", async () => {
    await startEcho();
    await deleteConv({ holdJob: true });
    // the machine does not answer
    vi.spyOn(k.app.get(SandboxService), "ifRunning").mockRejectedValue(
      new DeviceOfflineError(s.deviceId),
    );
    await ageNotice();
    expect(await attemptNow()).toBe("unreachable");
    const [row] = await notices();
    expect(row?.last_failure).toBe("unreachable");
    const wait = (row?.next_attempt_at.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(NOTICE_BACKOFF_MS / 2);
    // back: delivered on the next turn
    vi.restoreAllMocks();
    expect(await attemptNow()).toBe("delivered");
    expect(await logged()).toEqual([body(s.conversationId)]);
  });

  it("an error from a machine that answered stays owed inside the window and settles after it", async () => {
    await startEcho();
    await stopEcho();
    await deleteConv({ holdJob: true });
    // a pending service first: owed, no failure counted
    expect(await attemptNow()).toBe("owed");
    expect((await notices())[0]?.failures).toBe(0);
    // then the provider fails in an ordinary way (an outdated machine program, a provider bug)
    vi.spyOn(k.app.get(SandboxService), "ifRunning").mockRejectedValue(
      new Error("the machine does not know service.status"),
    );
    const warn = vi.spyOn((delivery as unknown as { log: { warn: () => void } }).log, "warn");
    expect(await attemptNow()).toBe("owed");
    expect(await attemptNow()).toBe("owed");
    const [row] = await notices();
    expect(row?.last_failure).toBe("the machine does not know service.status");
    expect(row?.failures).toBe(2);
    // the backoff counts failures only: the first failure waited 30 s, the second 60 s
    const wait = (row?.next_attempt_at.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(NOTICE_BACKOFF_MS);
    expect(wait).toBeLessThanOrEqual(2 * NOTICE_BACKOFF_MS + 5_000);
    // logged once for the row, not per attempt
    expect(warn).toHaveBeenCalledTimes(1);
    // past the window the answered failure settles it
    await ageNotice();
    expect(await attemptNow()).toBe("delivered");
    expect(await notices()).toEqual([]);
  });

  it("a delete that rolls back owes nothing", async () => {
    const outbox = k.app.get(OutboxService);
    const add = outbox.add.bind(outbox);
    vi.spyOn(outbox, "add").mockImplementation(async (job) => {
      if (job.name === CONVERSATION_NOTICE_JOB) throw new Error("outbox down");
      return add(job);
    });
    const res = await s.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/conversations/${s.conversationId}`,
    });
    expect(res.statusCode).toBe(500);
    expect(await notices()).toEqual([]);
    const conv = await db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", s.conversationId)
      .executeTakeFirstOrThrow();
    expect(conv.deleted_at).toBeNull();
  });

  it("the sweep tries an unreachable device once per tick and drops notices past 7 days", async () => {
    const owe = async (age = "0 seconds") => {
      const conversationId = await createConv(s.req, orgId, s.agentId);
      await db
        .updateTable("conversations")
        .set({ device_id: s.deviceId, deleted_at: sql<Date>`now()` })
        .where("id", "=", conversationId)
        .execute();
      const id = randomUUID();
      await db
        .insertInto("device_conversation_notices")
        .values({
          id,
          org_id: orgId,
          device_id: s.deviceId,
          conversation_id: conversationId,
          kind: "conversation_deleted",
          created_at: sql<Date>`now() - ${age}::interval`,
          next_attempt_at: sql<Date>`now() - interval '1 second'`,
        })
        .execute();
      return id;
    };
    await startEcho();
    const [a, b] = [await owe(), await owe()];
    const old = await owe("8 days");
    const ifRunning = vi
      .spyOn(k.app.get(SandboxService), "ifRunning")
      .mockRejectedValue(new DeviceOfflineError(s.deviceId));
    const out = await delivery.sweepOnce();
    // one attempt reached the silent machine; the device's other notice waits for a later tick
    expect(ifRunning).toHaveBeenCalledTimes(1);
    expect([...out.values()]).toEqual(["unreachable"]);
    expect(out.has(old)).toBe(false);
    const left = await db
      .selectFrom("device_conversation_notices")
      .select("id")
      .where("id", "in", [a, b, old])
      .execute();
    expect(left.map((r) => r.id).sort()).toEqual([a, b].sort());
    // an aborted sweep attempts nothing
    ifRunning.mockClear();
    expect((await delivery.sweepOnce(AbortSignal.abort())).size).toBe(0);
    expect(ifRunning).not.toHaveBeenCalled();
  });

  it("is never reached under another org, and a held lease skips a second attempt", async () => {
    await deleteConv({ holdJob: true });
    const [row] = await notices();
    if (!row) throw new Error("no notice owed");
    expect(await delivery.attempt(randomUUID(), row.id)).toBe("skipped");
    await db
      .updateTable("device_conversation_notices")
      .set({ claimed_until: sql<Date>`now() + interval '1 minute'` })
      .where("id", "=", row.id)
      .execute();
    expect(await delivery.attempt(orgId, row.id)).toBe("skipped");
    expect((await notices())[0]?.attempts).toBe(row.attempts);
  });

  it("the sweep delivers owed notices whose turn came", async () => {
    await startEcho();
    await deleteConv({ holdJob: true });
    expect((await logged()).length).toBe(0);
    const out = await delivery.sweepOnce();
    const [row] = await notices();
    expect(row).toBeUndefined();
    expect([...out.values()]).toContain("delivered");
    expect(await logged()).toEqual([body(s.conversationId)]);
  });

  it("drops a notice of a deleted device", async () => {
    await deleteConv({ holdJob: true });
    await db
      .updateTable("devices")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", s.deviceId)
      .execute();
    expect(await attemptNow()).toBe("delivered");
    expect(await notices()).toEqual([]);
  });
});

describe("conversation notice lease (two replicas)", () => {
  beforeAll(async () => {
    b = await replica();
  });

  /**
   * An owed notice of a fresh deleted conversation on the device, as the deletion writes it but
   * without its prompt job and not yet the sweep's turn, so only the test's attempts reach it.
   */
  const owedNotice = async (): Promise<{ id: string; conversationId: string }> => {
    const conversationId = await createConv(s.req, orgId, s.agentId);
    await db
      .updateTable("conversations")
      .set({ device_id: s.deviceId, deleted_at: sql<Date>`now()` })
      .where("id", "=", conversationId)
      .execute();
    const id = randomUUID();
    await db
      .insertInto("device_conversation_notices")
      .values({
        id,
        org_id: orgId,
        device_id: s.deviceId,
        conversation_id: conversationId,
        kind: "conversation_deleted",
        next_attempt_at: sql<Date>`now() + interval '1 hour'`,
      })
      .execute();
    return { id, conversationId };
  };

  const linesFor = async (conversationId: string) =>
    (await logged()).filter((l) => l === body(conversationId));

  const gone = async (id: string) =>
    (await db.selectFrom("device_conversation_notices").select("id").where("id", "=", id).execute())
      .length === 0;

  it("overlapping attempts on both replicas deliver the notice once", async () => {
    await startEcho();
    const other = (b as TestKernel).app.get(ConversationNoticeDelivery);
    for (let i = 0; i < 5; i++) {
      const n = await owedNotice();
      const outcomes: NoticeOutcome[] = await Promise.all([
        delivery.attempt(orgId, n.id),
        other.attempt(orgId, n.id),
      ]);
      expect(outcomes.sort()).toEqual(["delivered", "skipped"]);
      expect(await linesFor(n.conversationId)).toHaveLength(1);
      expect(await gone(n.id)).toBe(true);
    }
  });

  it("a held lease keeps the other replica out until it runs out", async () => {
    await startEcho();
    const other = (b as TestKernel).app.get(ConversationNoticeDelivery);
    const n = await owedNotice();
    // this replica's attempt stalls inside the device call while it holds the lease
    let release: () => void = () => {};
    const stalled = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const sandbox = k.app.get(SandboxService);
    const realIfRunning = sandbox.ifRunning.bind(sandbox);
    vi.spyOn(sandbox, "ifRunning").mockImplementation(async (...args) => {
      entered();
      await stalled;
      return realIfRunning(...args);
    });
    const first = delivery.attempt(orgId, n.id);
    await inside;
    expect(await other.attempt(orgId, n.id)).toBe("skipped");
    expect(await linesFor(n.conversationId)).toEqual([]);
    // the first replica is taken for dead: its lease runs out, the other takes the notice
    await db
      .updateTable("device_conversation_notices")
      .set({ claimed_until: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", n.id)
      .execute();
    expect(await other.attempt(orgId, n.id)).toBe("delivered");
    expect(await linesFor(n.conversationId)).toHaveLength(1);
    // the stalled attempt wakes: at least once, the service may hear it again (idempotent)
    release();
    await first;
    expect((await linesFor(n.conversationId)).length).toBeLessThanOrEqual(2);
    expect(await gone(n.id)).toBe(true);
  });
});
