import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { createLogger } from "../../src/log.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { taskListTool } from "../../src/tools/builtins/sandbox/task-list.js";
import { taskOutputTool } from "../../src/tools/builtins/sandbox/task-output.js";
import { taskStopTool } from "../../src/tools/builtins/sandbox/task-stop.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  barrier,
  MANAGED_GENERATION,
  managedTaskFixture,
  textOf,
} from "../helpers/managed-background.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Managed background task consumers (permission runtime cutover phase 8.3): TaskOutput over
 * retained positional output with a persisted byte cursor, the HTTP suffix, TaskStop and the
 * poller by exact ref only, exactly one conditional finish, and uncertain records retained.
 */

const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;
let owner: Account;
let added: { name: string; jobId: string }[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  redis = new Redis(rd.url);
  accounts = accountsFor(kernelDb(raw));
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  added = [];
  const outbox = k.app.get(OutboxService);
  const add = outbox.add.bind(outbox);
  vi.spyOn(outbox, "add").mockImplementation(async (job) => {
    added.push({ name: job.name, jobId: job.jobId });
    return add(job);
  });
});

const fixture = () =>
  managedTaskFixture({ kernels: [k], raw, login: "owner", password: PW, accountId: owner.id });

/** The poller as the worker builds it (this kernel is API-only). */
const poller = () =>
  new BackgroundTaskPollJob(
    k.app.get(BackgroundTaskStore),
    k.app.get(BackgroundTaskFinisher),
    k.app.get(EventLog),
    k.app.get(SandboxService),
    k.app.get(KernelConfigService),
    {} as LockService,
    createLogger("error", { write: () => {} }),
    k.app.get(BackgroundTaskStopper),
  );

const ensureRuns = (conversationId: string) =>
  added.filter((j) => j.name === "ensure-run" && j.jobId.includes(conversationId));

describe("TaskOutput on managed output", () => {
  it("a 200 KiB burst with more than 20 lines before the first read is delivered byte-exactly across reads", async () => {
    const f = await fixture();
    const lines = Array.from({ length: 9000 }, (_, i) => `line ${i} ${"é😀".repeat(i % 5)}`);
    const all = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    expect(all.length).toBeGreaterThan(200 * 1024);
    f.provider.write(new Uint8Array(all));
    // a capacity below 4,096 bytes, as from a small negotiated frame
    f.provider.state.capacity = 3072;
    let got = Buffer.alloc(0);
    let first = "";
    for (let i = 0; i < 20; i++) {
      const before = (await f.taskRow()).read_offset;
      const r = textOf(await f.taskOutput({}));
      if (i === 0) first = r;
      const after = Number((await f.taskRow()).read_offset);
      got = Buffer.concat([got, all.subarray(Number(before), after)]);
      if (after === all.length) break;
    }
    expect(got.equals(all)).toBe(true);
    // the first read returned more than 20 lines: positional output, not a tail
    expect(first.split("\n").length).toBeGreaterThan(100);
    expect(first).toMatch(/more bytes of output after this/);
    expect(f.provider.calls.readOutput.every((q) => q.maxBytes <= 65_536)).toBe(true);
    // reads use the exact ref only: no exec, native operation, create or resume
    expect(f.provider.calls.forbidden).toEqual([]);
    expect(f.provider.calls.start).toBe(1);
  });

  it("a dropped connection mid-read moves no cursor; the retry continues from the same byte", async () => {
    const f = await fixture();
    f.provider.write("hello world\n");
    f.provider.state.capacity = 4;
    let reads = 0;
    f.provider.state.beforeRead = async () => {
      reads++;
      if (reads === 3) f.provider.state.dropNextRead = true;
    };
    await expect(f.taskOutput({})).rejects.toThrow();
    expect(Number((await f.taskRow()).read_offset)).toBe(0);
    f.provider.state.beforeRead = undefined;
    expect(textOf(await f.taskOutput({}))).toContain("hello world");
    expect(Number((await f.taskRow()).read_offset)).toBe(12);
  });

  it("repeated identical bytes are new output by position", async () => {
    const f = await fixture();
    f.provider.write("tick\n");
    expect(textOf(await f.taskOutput({}))).toContain("tick");
    f.provider.write("tick\n");
    const second = textOf(await f.taskOutput({}));
    expect(second).toContain("tick");
    expect(second).not.toContain("[No new output.]");
    expect(Number((await f.taskRow()).read_offset)).toBe(10);
    expect(textOf(await f.taskOutput({}))).toContain("[No new output.]");
  });

  it("withholds a live split character and finds a login prompt split across reads", async () => {
    const f = await fixture();
    const emoji = Buffer.from("😀", "utf8");
    f.provider.write(
      new Uint8Array(
        Buffer.concat([
          Buffer.from("! First copy your one-time code: 1A2B-C3D4\nwaiting "),
          emoji.subarray(0, 2),
        ]),
      ),
    );
    const first = await f.taskOutput({});
    expect(textOf(first)).toContain("one-time code");
    expect((first as { loginCode?: unknown }).loginCode).toBeUndefined();
    const cursor = Number((await f.taskRow()).read_offset);
    // the two bytes of the cut character are not delivered
    expect(cursor).toBe(Buffer.byteLength("! First copy your one-time code: 1A2B-C3D4\nwaiting "));
    f.provider.write(
      new Uint8Array(
        Buffer.concat([
          emoji.subarray(2),
          Buffer.from("\n- Press Enter to open https://github.com/login/device in your browser...\n"),
        ]),
      ),
    );
    const second = await f.taskOutput({});
    expect(textOf(second)).toContain("😀");
    expect((second as { loginCode?: unknown }).loginCode).toEqual({ url: "https://github.com/login/device", code: "1A2B-C3D4" });
  });

  it("at a verified terminal end consumes invalid bytes, finishes once reported and owes no wake", async () => {
    const f = await fixture();
    f.provider.write(new Uint8Array([0x6f, 0x6b, 0x0a, 0xf0, 0x9f]));
    f.provider.exit(3);
    const r = textOf(await f.taskOutput({}));
    expect(r).toContain("Status: failed, exit code 3");
    expect(r).toContain("�");
    const row = await f.taskRow();
    expect(Number(row.read_offset)).toBe(5);
    expect(row).toMatchObject({ status: "failed", exit_code: 3, launch_state: "terminal" });
    const events = await f.finishedEvents();
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { reported: boolean }).reported).toBe(true);
    expect(ensureRuns(f.conversationId)).toHaveLength(0);
    // the true terminal settlement retires the running authority
    expect((await f.intent()).state).toBe("completed");
    // a second read sees the finished task and no new bytes
    expect(textOf(await f.taskOutput({}))).toContain("[No new output.]");
    expect(await f.finishedEvents()).toHaveLength(1);
  });

  it("a timed-out exit is reported as timed out", async () => {
    const f = await fixture();
    f.provider.exit(137, true);
    expect(textOf(await f.taskOutput({}))).toContain("Status: timed out, exit code 137");
  });

  it("expired output is labelled, moves no cursor and never invents bytes", async () => {
    const f = await fixture();
    f.provider.write("some output\n");
    f.provider.only().retained = "expired";
    const r = textOf(await f.taskOutput({}));
    expect(r).toContain("[Output unavailable: the task's retained output has expired.]");
    expect(r).not.toContain("some output");
    expect(Number((await f.taskRow()).read_offset)).toBe(0);
  });

  it("a finished task with lost output shows its labelled finish summary, not new output", async () => {
    const f = await fixture();
    f.provider.write("a\nb\nfinal line\n");
    f.provider.exit(0);
    await poller().pollOnce();
    f.provider.only().retained = "lost";
    const r = textOf(await f.taskOutput({}));
    expect(r).toContain("[Output unavailable: the task's retained output was lost.]");
    expect(r).toContain("Last lines recorded when the task finished (not new output):");
    expect(r).toContain("final line");
    expect(Number((await f.taskRow()).read_offset)).toBe(0);
  });

  it("a malformed recorded ref or generation is refused before any provider call", async () => {
    const f = await fixture();
    const before = f.provider.calls.status + f.provider.calls.readOutput.length;
    await f.db
      .updateTable("background_tasks")
      .set({ instance_generation: "not-a-generation" })
      .where("id", "=", f.taskId)
      .execute();
    await expect(f.taskOutput({})).rejects.toThrow(/execution reference/);
    await f.db
      .updateTable("background_tasks")
      .set({
        instance_generation: String(MANAGED_GENERATION),
        execution_ref: JSON.stringify({ ...f.provider.only().ref, operationId: "other" }),
      })
      .where("id", "=", f.taskId)
      .execute();
    await expect(f.taskOutput({})).rejects.toThrow(/execution reference/);
    expect(f.provider.calls.status + f.provider.calls.readOutput.length).toBe(before);
    // the poller skips it too and finishes nothing
    expect(await poller().pollOnce()).toBe(0);
    expect((await f.taskRow()).status).toBe("running");
  });

  it("another conversation cannot read the task", async () => {
    const f = await fixture();
    const other = await f.req({
      method: "POST",
      url: `/api/v1/orgs/${f.orgId}/conversations`,
      payload: { agentId: f.agentId },
    });
    const otherId = (other.json() as { conversation: { id: string } }).conversation.id;
    await f.db
      .updateTable("conversations")
      .set({ device_id: f.deviceId })
      .where("id", "=", otherId)
      .execute();
    await expect(f.taskOutput({}, k, { conversationId: otherId })).rejects.toThrow(
      /No background task/,
    );
  });

  it("a suspended instance is never resumed for a read; the task is lost with its record retained", async () => {
    const f = await fixture();
    await f.db
      .updateTable("device_instances")
      .set({ status: "suspended" })
      .where("device_id", "=", f.deviceId)
      .execute();
    const r = textOf(await f.taskOutput({}));
    expect(r).toContain("[Output unavailable: the sandbox is suspended.");
    expect(f.provider.calls.forbidden).toEqual([]);
    const row = await f.taskRow();
    expect(row).toMatchObject({ status: "lost", lost_reason: "sandbox_suspended" });
    // the process may still exist: the record stays an uncertain one
    expect(row.launch_state).toBe("cancel-pending");
    expect((await f.intent()).state).toBe("background-running");
    // ordinary pruning keeps it
    await f.db
      .updateTable("background_tasks")
      .set({ finished_at: new Date(Date.now() - 400 * 86_400_000) })
      .where("id", "=", f.taskId)
      .execute();
    expect(await k.app.get(BackgroundTaskStore).pruneFinished(new Date())).toBe(0);
  });

  it("a non-blocking call keeps its run budget; a blocking call returns once the task exits", async () => {
    const f = await fixture();
    f.provider.write("x\n");
    const quick = textOf(await f.taskOutput({ block: true, timeout: 0 }));
    expect(quick).toContain("Status: running");
    f.provider.exit(0);
    const done = textOf(await f.taskOutput({ block: true, timeout: 60_000 }));
    expect(done).toContain("Status: completed, exit code 0");
  });
});

describe("TaskStop and the stopper on managed tasks", () => {
  it("stops by exact ref with the five-second grace, reports the last 20 lines once", async () => {
    const f = await fixture();
    f.provider.write(`${Array.from({ length: 40 }, (_, i) => `out ${i}`).join("\n")}\n`);
    const r = textOf(await f.taskStop());
    expect(r).toContain("was stopped");
    expect(r).toContain("out 39");
    expect(r).not.toContain("out 19\n");
    expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
    expect(f.provider.calls.forbidden).toEqual([]);
    const row = await f.taskRow();
    expect(row).toMatchObject({ status: "stopped", launch_state: "terminal" });
    const [event] = await f.finishedEvents();
    const payload = event?.payload as { reported: boolean; lastLines: string; status: string };
    expect(payload).toMatchObject({ reported: true, status: "stopped" });
    expect(payload.lastLines.split("\n").filter((l) => l !== "")).toHaveLength(20);
    expect((await f.intent()).state).toBe("completed");
  });

  it("an already-exited task is reported as finished with its exit, not as stopped", async () => {
    const f = await fixture();
    f.provider.exit(0);
    const r = textOf(await f.taskStop());
    expect(r).toContain("had already finished");
    expect(r).toContain("Status: completed, exit code 0");
    expect((await f.taskRow()).status).toBe("completed");
  });

  it("a pending cancellation writes no stopped event; it finishes once the exact stop settles", async () => {
    const f = await fixture();
    f.provider.only().stopAs = "cancel-pending";
    const r = textOf(await f.taskStop());
    expect(r).toMatch(/stop requested/);
    const row = await f.taskRow();
    expect(row).toMatchObject({
      status: "running",
      launch_state: "cancel-pending",
      cancel_requested_by: "tool",
      stopping_at: null,
    });
    expect(await f.finishedEvents()).toHaveLength(0);
    // the device applies it: the poller's exact stop settles the task, exactly once
    f.provider.only().stopAs = "stopped";
    expect(await poller().pollOnce()).toBe(1);
    expect(await poller().pollOnce()).toBe(0);
    expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(await f.finishedEvents()).toHaveLength(1);
  });

  it("a person's pending stop never wakes the conversation when it settles later", async () => {
    const f = await fixture();
    f.provider.only().stopAs = "cancel-pending";
    const res = await f.req({
      method: "POST",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks/${f.taskId}/stop`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { task: { status: string; stopping: boolean } }).task).toMatchObject({
      status: "running",
      stopping: true,
    });
    f.provider.only().stopAs = "stopped";
    await poller().pollOnce();
    const [event] = await f.finishedEvents();
    expect((event?.payload as { stoppedBy?: string }).stoppedBy).toBe("person");
    expect(ensureRuns(f.conversationId)).toHaveLength(0);
  });

  it("lost supervision is a lost finish that keeps the uncertain record and running authority", async () => {
    const f = await fixture();
    f.provider.only().stopAs = "lost";
    const r = textOf(await f.taskStop());
    expect(r).toContain("is lost");
    expect(await f.taskRow()).toMatchObject({
      status: "lost",
      lost_reason: "supervision_lost",
      launch_state: "cancel-pending",
    });
    expect((await f.intent()).state).toBe("background-running");
  });

  it("a revocation's cancel-pending task with a ref reaches a terminal state through the exact stop", async () => {
    const f = await fixture();
    await k.app.get(TransactionHost).run(async () => {
      const ceiling = k.app.get(PermissionCeilingWrites);
      const subject = { orgId: f.orgId, deviceId: f.deviceId };
      await ceiling.lock(subject, "device");
      await ceiling.publishLocked(subject, "device");
    });
    expect((await f.taskRow()).launch_state).toBe("cancel-pending");
    expect(await poller().pollOnce()).toBe(1);
    expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
    // a revocation's stop is told to the model: the durable wake is owed
    expect(ensureRuns(f.conversationId)).toHaveLength(1);
  });

  it("a stop claimed before the ref settles through the acknowledged cancellation", async () => {
    const f = await managedTaskFixture({
      kernels: [k],
      raw,
      login: "owner",
      password: PW,
      accountId: owner.id,
      launch: false,
    });
    const store = k.app.get(BackgroundTaskStore);
    const entered = barrier();
    const release = barrier();
    const startFn = f.provider.impl.background?.start.bind(f.provider.impl.background);
    if (!f.provider.impl.background || !startFn) throw new Error("no background");
    f.provider.impl.background.start = async (...args) => {
      const ref = await startFn(...args);
      entered.resolve();
      await release.promise;
      return ref;
    };
    const { runInBackgroundManaged } = await import("../../src/tools/builtins/sandbox/bash.js");
    const launch = runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    }).then(
      () => "ok",
      (e: unknown) => String(e),
    );
    await entered.promise;
    const row = await f.taskRow();
    const stopped = await k.app.get(BackgroundTaskStopper).stop(await getTask(store, row.id), "tool");
    expect(stopped.status).toBe("running");
    release.resolve();
    expect(await launch).toMatch(/stopped while it was starting/);
    expect(await f.taskRow()).toMatchObject({
      launch_state: "cancel-pending",
      cancel_requested_by: "tool",
      stopping_at: null,
    });
    expect(await poller().pollOnce()).toBe(1);
    expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
  });
});

async function getTask(store: BackgroundTaskStore, id: string) {
  const t = await store.get(id);
  if (!t) throw new Error("no task");
  return t;
}

describe("the poller on managed tasks", () => {
  it("finishes an exited task once with its last lines and owes the durable wake", async () => {
    const f = await fixture();
    f.provider.write(`${Array.from({ length: 30 }, (_, i) => `p${i}`).join("\n")}\n`);
    f.provider.exit(0);
    expect(await poller().pollOnce()).toBe(1);
    expect(await poller().pollOnce()).toBe(0);
    const events = await f.finishedEvents();
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { reported: boolean; lastLines: string };
    expect(payload.reported).toBe(false);
    expect(payload.lastLines).toContain("p29");
    expect(payload.lastLines).not.toContain("p9\n");
    expect(ensureRuns(f.conversationId)).toHaveLength(1);
    expect(f.provider.calls.forbidden).toEqual([]);
    // a settled record is pruned normally
    await f.db
      .updateTable("background_tasks")
      .set({ finished_at: new Date(Date.now() - 400 * 86_400_000) })
      .where("id", "=", f.taskId)
      .execute();
    expect(await k.app.get(BackgroundTaskStore).pruneFinished(new Date())).toBe(1);
  });

  it("leaves a task of an unavailable device provider alone", async () => {
    const f = await fixture();
    f.provider.exit(0);
    await f.db
      .updateTable("devices")
      .set({ provider: "@not-loaded" })
      .where("id", "=", f.deviceId)
      .execute();
    expect(await poller().pollOnce()).toBe(0);
    expect((await f.taskRow()).status).toBe("running");
    expect(f.provider.calls.status).toBe(0);
  });
});

describe("HTTP output of managed tasks", () => {
  it("returns the requested suffix ending at the probed total, with no 20-line cap", async () => {
    const f = await fixture();
    const body = `${Array.from({ length: 2000 }, (_, i) => `row ${i} ${"€".repeat(i % 3)}`).join("\n")}\n`;
    const bytes = Buffer.from(body, "utf8");
    f.provider.write(new Uint8Array(bytes));
    f.provider.state.capacity = 1000;
    let reads = 0;
    f.provider.state.beforeRead = async () => {
      if (++reads === 2) f.provider.write("GROWN AFTER THE PROBE\n");
    };
    const res = await f.req({
      method: "GET",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks/${f.taskId}/output?tail=5000`,
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { text: string; truncated: boolean; source: string };
    expect(out.source).toBe("live");
    expect(out.truncated).toBe(true);
    const expected = bytes.subarray(bytes.length - 5000).toString("utf8");
    expect(expected.endsWith(out.text)).toBe(true);
    expect(expected.length - out.text.length).toBeLessThanOrEqual(1);
    expect(out.text).not.toContain("GROWN");
    expect(out.text.split("\n").length).toBeGreaterThan(20);
    // the HTTP read never moves the model's cursor
    expect(Number((await f.taskRow()).read_offset)).toBe(0);
  });

  it("an ancestor conversation reads a sub-agent's task; another org cannot", async () => {
    const f = await fixture();
    f.provider.write("child output\n");
    const childId = randomUUID();
    await f.db
      .insertInto("conversations")
      .values({
        id: childId,
        org_id: f.orgId,
        account_id: owner.id,
        agent_id: f.agentId,
        kind: "subagent",
        parent_conversation_id: f.conversationId,
      } as never)
      .execute();
    await f.db
      .updateTable("background_tasks")
      .set({ conversation_id: childId })
      .where("id", "=", f.taskId)
      .execute();
    const url = (org: string) =>
      `/api/v1/orgs/${org}/conversations/${f.conversationId}/background-tasks/${f.taskId}/output`;
    const ok = await f.req({ method: "GET", url: url(f.orgId) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { text: string }).text).toBe("child output\n");
    const other = await f.req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Other" } });
    const otherOrg = (other.json() as { org: { id: string } }).org.id;
    expect((await f.req({ method: "GET", url: url(otherOrg) })).statusCode).toBe(404);
  });

  it("a finished task whose output is lost falls back to its labelled finish summary", async () => {
    const f = await fixture();
    f.provider.write("x\nlast words\n");
    f.provider.exit(1);
    await poller().pollOnce();
    f.provider.only().retained = "lost";
    const res = await f.req({
      method: "GET",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks/${f.taskId}/output`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: "event",
      truncated: true,
      unavailable: { reason: "output_missing", environment: "local" },
    });
    expect((res.json() as { text: string }).text).toContain("last words");
  });

  it("an unavailable device provider is reported, never read", async () => {
    const f = await fixture();
    await f.db
      .updateTable("devices")
      .set({ provider: "@not-loaded" })
      .where("id", "=", f.deviceId)
      .execute();
    const res = await f.req({
      method: "GET",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks/${f.taskId}/output`,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("unavailable");
  });
});

describe("tool and HTTP surfaces stay the same for managed tasks", () => {
  it("the task tools' input schemas and the HTTP view fields are unchanged", async () => {
    const f = await fixture();
    const deps = f.depsOf(k);
    expect(taskOutputTool(deps).spec.inputSchema).toEqual({
      type: "object",
      properties: {
        task_id: {
          type: "string",
          minLength: 1,
          description: "The id of the background task (bt_...) that Bash returned.",
        },
        block: { type: "boolean", description: "Whether to wait for the task to finish. Default true." },
        timeout: {
          type: "number",
          minimum: 0,
          maximum: 600_000,
          description:
            "Milliseconds to wait at most when block is true. Default 30000, at most 600000; never past the run's own time limit.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    });
    expect(taskStopTool(deps).spec.inputSchema).toMatchObject({
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    });
    const list = await f.req({
      method: "GET",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks`,
    });
    const [view] = (list.json() as { tasks: Record<string, unknown>[] }).tasks;
    expect(Object.keys(view ?? {}).sort()).toEqual(
      [
        "command",
        "conversationId",
        "description",
        "exitCode",
        "finishedAt",
        "id",
        "lostReason",
        "startedAt",
        "status",
        "stopping",
        "subagentId",
      ].sort(),
    );
    // an acknowledged managed task is running, not "starting", for the model and the API
    expect(view).toMatchObject({ status: "running", stopping: false });
    const listed = textOf(await taskListTool(deps).run({}, await f.ctxFor()));
    expect(listed).toContain("running for");
  });
});

describe("a retried Bash call of a finished managed task", () => {
  it("reports the start it made, not a refusal, and starts nothing again", async () => {
    const f = await fixture();
    f.provider.exit(0);
    await poller().pollOnce();
    expect(await f.taskRow()).toMatchObject({ status: "completed", launch_state: "terminal" });
    await f.db
      .updateTable("runs")
      .set({ execution_id: randomUUID() })
      .where("id", "=", f.runId)
      .execute();
    const { runInBackgroundManaged } = await import("../../src/tools/builtins/sandbox/bash.js");
    const r = await runInBackgroundManaged(f.depsOf(k), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    });
    expect(textOf(r)).toContain(f.taskId);
    expect(textOf(r)).toContain("Output:");
    expect(f.provider.calls.start).toBe(1);
  });
});
