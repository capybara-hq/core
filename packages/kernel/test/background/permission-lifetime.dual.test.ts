import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../../src/sandbox/operation-reconcile.job.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { runInBackgroundManaged } from "../../src/tools/builtins/sandbox/bash.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { barrier, managedTaskFixture, textOf } from "../helpers/managed-background.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Managed background task lifetime across two replicas (permission runtime cutover phase 8.3):
 * two kernels on one database and Redis read, poll, stop and revoke the same exact-ref task at
 * the same time. The finish is one conditional update in its event's transaction, so exactly one
 * `background_task_finished` is written, the byte cursor only moves forward by delivered bytes,
 * and a start dispatched on one replica is never re-sent by the other's recovery.
 */

const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let a: TestKernel;
let b: TestKernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let accounts: AccountsService;
let owner: Account;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const config = KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 6 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    ...MODEL_PLUGINS_CONFIG,
  });
  a = await startKernel(config, { env: {}, logger: createLogger("error", { write: () => {} }) });
  b = await startKernel(config, { env: {}, logger: createLogger("error", { write: () => {} }) });
  raw = createDb(pgc.url, 6);
  redis = new Redis(rd.url);
  accounts = accountsFor(kernelDb(raw));
});
afterAll(async () => {
  await b?.close();
  await a?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
});

const fixture = (launch = true) =>
  managedTaskFixture({
    kernels: [a, b],
    raw,
    login: "owner",
    password: PW,
    accountId: owner.id,
    launch,
  });

const poller = (k: TestKernel) =>
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

/** Holds the next `n` output reads until all of them arrived (both replicas read at once). */
function holdReads(f: Awaited<ReturnType<typeof fixture>>, n: number) {
  const all = barrier();
  let arrived = 0;
  f.provider.state.beforeRead = async () => {
    if (arrived >= n) return;
    arrived++;
    if (arrived === n) all.resolve();
    await all.promise;
  };
}

describe("managed background tasks across two replicas", () => {
  it("concurrent TaskOutput reads of an exited task finish it once and deliver every byte", async () => {
    const f = await fixture();
    const body = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
    f.provider.write(body);
    f.provider.exit(0);
    holdReads(f, 2);
    const [ra, rb] = await Promise.all([f.taskOutput({}, a), f.taskOutput({}, b)]);
    // concurrent readers both deliver the unread bytes; the cursor only moves forward
    expect(textOf(ra)).toContain("line 299");
    expect(textOf(rb)).toContain("line 299");
    expect(Number((await f.taskRow()).read_offset)).toBe(Buffer.byteLength(body));
    const events = await f.finishedEvents();
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { reported: boolean } | undefined)?.reported).toBe(true);
    expect(await f.taskRow()).toMatchObject({ status: "completed", launch_state: "terminal" });
  });

  it("a poll on one replica and a TaskStop on the other write one finish", async () => {
    const f = await fixture();
    f.provider.write("done\n");
    f.provider.exit(0);
    const [polled] = await Promise.all([poller(b).pollOnce(), f.taskStop(a)]);
    expect(polled).toBeLessThanOrEqual(1);
    expect(await f.finishedEvents()).toHaveLength(1);
    expect((await f.taskRow()).status).toBe("completed");
  });

  it("two replicas applying the same owed cancellation stop it once by its exact ref", async () => {
    const f = await fixture();
    f.provider.only().stopAs = "cancel-pending";
    expect(textOf(await f.taskStop(a))).toMatch(/stop requested/);
    f.provider.only().stopAs = "stopped";
    const [na, nb] = await Promise.all([poller(a).pollOnce(), poller(b).pollOnce()]);
    expect(na + nb).toBe(1);
    expect(f.provider.calls.stop).toHaveLength(2);
    expect(await f.finishedEvents()).toHaveLength(1);
    expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
  });

  it("a revocation written on one replica is applied by the other's poller, exactly once", async () => {
    const f = await fixture();
    await a.app.get(TransactionHost).run(async () => {
      const ceiling = a.app.get(PermissionCeilingWrites);
      const subject = { orgId: f.orgId, deviceId: f.deviceId };
      await ceiling.lock(subject, "device");
      await ceiling.publishLocked(subject, "device");
    });
    expect((await f.intent()).state).toBe("revoked");
    const [na, nb] = await Promise.all([poller(a).pollOnce(), poller(b).pollOnce()]);
    expect(na + nb).toBe(1);
    expect(f.provider.calls.stop).toEqual([{ graceMs: 5000 }]);
    expect(await f.taskRow()).toMatchObject({ status: "stopped", launch_state: "terminal" });
    expect(await f.finishedEvents()).toHaveLength(1);
  });

  it("an HTTP read on one replica ends at its probed total while the other reads and finishes", async () => {
    const f = await fixture();
    f.provider.write("first part\n");
    // both replicas probe first; the output grows before either reads its range
    const probes = barrier();
    let reads = 0;
    f.provider.state.beforeRead = async () => {
      reads++;
      if (reads === 2) probes.resolve();
      if (reads <= 2) await probes.promise;
      if (reads === 3) f.provider.write("GROWN\n");
    };
    const http = f.req({
      method: "GET",
      url: `/api/v1/orgs/${f.orgId}/conversations/${f.conversationId}/background-tasks/${f.taskId}/output`,
    });
    const tool = (async () => {
      const r = await f.taskOutput({}, b);
      f.provider.write("second part\n");
      f.provider.exit(0);
      return r;
    })();
    const [res, out] = await Promise.all([http, tool]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { text: string }).text).toBe("first part\n");
    expect(textOf(out)).toContain("first part");
    expect(textOf(out)).not.toContain("GROWN");
    f.provider.state.beforeRead = undefined;
    const rest = textOf(await f.taskOutput({}, a));
    expect(rest).toContain("GROWN");
    expect(rest).toContain("second part");
    expect(await f.finishedEvents()).toHaveLength(1);
    expect(Number((await f.taskRow()).read_offset)).toBe(
      Buffer.byteLength("first part\nGROWN\nsecond part\n"),
    );
  });

  it("recovery on one replica never re-sends a start the other replica is still dispatching", async () => {
    const f = await fixture(false);
    const entered = barrier();
    const release = barrier();
    f.provider.state.beforeStart = async () => {
      entered.resolve();
      await release.promise;
    };
    const launch = runInBackgroundManaged(f.depsOf(a), await f.ctxFor(), {
      command: "npm run dev",
      description: "Serve",
      run_in_background: true,
    });
    await entered.promise;
    expect((await f.intent()).state).toBe("dispatching");
    const recovery = new SandboxOperationReconcileJob(
      b.app.get(SandboxOperationIntents),
      b.app.get(KernelDb),
      b.app.get(SandboxProviders),
      b.app.get(SandboxService),
      b.app.get(BackgroundTaskStore),
      b.app.get(BackgroundTaskStopper),
    ).reconcile(f.operationId);
    await recovery;
    expect(f.provider.calls.start).toBe(1);
    release.resolve();
    expect(textOf(await launch)).toContain("Output:");
    expect(f.provider.executions.size).toBe(1);
    expect(await f.taskRow()).toMatchObject({ launch_state: "acknowledged" });
    expect((await f.intent()).state).toBe("background-running");
  });

  it("a TaskOutput on one replica and a poll on the other settle an applied cancellation once, stopped", async () => {
    const f = await fixture();
    f.provider.only().stopAs = "cancel-pending";
    await f.taskStop(a);
    f.provider.applyPendingCancel();
    await Promise.all([f.taskOutput({}, a), poller(b).pollOnce()]);
    const events = await f.finishedEvents();
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { status: string } | undefined)?.status).toBe("stopped");
  });
});
