import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchScript, newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { createFakeSandbox } from "../fixtures/plugins/sandbox-fake/index.js";
import { handlesFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, waitFor } from "../helpers/runs.js";
import { sandboxServiceFor, seedEnvironment } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Two replicas, both with the worker role, poll the same sandbox every second (spec
 * 2026-11-05-background-bash-design §4.3, Review Focus 3): the `@LockedInterval` tick runs once
 * across replicas and the finish is a conditional update in the event's transaction, so a task
 * that finishes while both replicas poll for 30 s gets exactly one `background_task_finished`.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const OBSERVE_MS = 30_000;

describe("background task poll (dual replica)", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let root: string;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let redis: Redis;
  let sandbox: SandboxService;
  let store: BackgroundTaskStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-bg-poll-dual-"));
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, SANDBOX_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: { "sandbox-fake": { root } },
      config: { sandbox: { background: { pollSeconds: 1 } } },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    redis = new Redis(rdc.url);
    const config = KernelConfigSchema.parse({
      db: { url: h.dbUrl },
      redis: { url: rdc.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    });
    // this process starts the task in the replicas' sandbox (one fake provider root)
    sandbox = sandboxServiceFor({
      db,
      redis,
      provider: () => ({ plugin: "sandbox-fake", impl: createFakeSandbox(root) }),
      config: () => config,
      log: {},
    });
    const hd = handlesFor(raw);
    store = new BackgroundTaskStore(hd.db, hd.txHost, {} as never);
  }, 600_000);

  afterAll(async () => {
    if (db) {
      const rows = await db.selectFrom("environment_instances").select("environment_id").execute();
      for (const r of rows) await sandbox.destroyEnvironment(r.environment_id).catch(() => {});
    }
    await h?.stop();
    redis?.disconnect();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
    if (root) await rm(root, { recursive: true, force: true });
  }, 180_000);

  it("a task finishing while both replicas poll gets exactly one finish event", async () => {
    expect(h.replicas.map((r) => r.roles.includes("worker"))).toEqual([true, true]);
    const c = await seedConversation(raw);
    const environmentId = await seedEnvironment(raw, c.orgId, c.accountId);
    const id = newTaskId();
    const t0 = Date.now();
    const sid = await sandbox.withSandbox(
      {
        orgId: c.orgId,
        environmentId,
        holderConversationId: c.conversationId,
        actor: { accountId: c.accountId, conversationId: c.conversationId },
      },
      async (hd, p, _info, sig) => {
        const r = await p.exec(hd, {
          command: launchScript(id, "sleep 4; echo done", 60),
          cwd: "/workspace",
          timeoutMs: 20_000,
          maxOutputBytes: 4096,
          signal: sig,
        });
        expect(r.exitCode).toBe(0);
        return r.stdout.trim();
      },
      AbortSignal.timeout(30_000),
    );
    const { handle } = await db
      .selectFrom("environment_instances")
      .select("handle")
      .where("environment_id", "=", environmentId)
      .executeTakeFirstOrThrow();
    const record = join(root, "instances", (handle as { id: string }).id, "sessions", sid);
    await waitFor(async () => existsSync(record), 10_000, "session record");
    const instance = await sandbox.currentInstance(environmentId);
    const startedAt = new Date();
    await store.insert({
      id,
      orgId: c.orgId,
      conversationId: c.conversationId,
      sandboxConversationId: c.conversationId,
      environmentId,
      runId: "run-x",
      callId: "call-x",
      triggerAccountId: c.accountId,
      description: "Sleep then print",
      command: "sleep 4; echo done",
      sid,
      outputPath: taskOutputPath(id),
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + 60_000),
      sandboxCreatedAt: instance?.createdAt as Date,
    });

    const finished = await waitFor(
      async () => {
        const r = await store.get(id);
        return r?.status !== "running" && r;
      },
      20_000,
      "task finished",
      200,
    );
    expect(finished).toMatchObject({ status: "completed", exitCode: 0 });
    // both replicas keep polling for the rest of the window
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + OBSERVE_MS - Date.now())));
    const events = (await eventsOf(db, c.conversationId)).filter(
      (e) => e.type === "background_task_finished",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      taskId: id,
      status: "completed",
      lastLines: "done\n",
    });
  }, 120_000);
});
