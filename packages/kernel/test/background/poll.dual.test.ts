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
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { launchManaged } from "../helpers/background-fake.js";
import { startClaimedRun } from "../helpers/managed-calls.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, runConfig, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * Two replicas, both with the worker role, poll the same sandbox every second (spec
 * 2026-11-05-background-bash-design §4.3, Review Focus 3): the `@LockedInterval` tick runs once
 * across replicas and the finish is a conditional update in the event's transaction, so a task
 * that finishes while both replicas poll for 30 s gets exactly one `background_task_finished`.
 * The task is a managed one, launched through the real `Bash` path by an api-only kernel in this
 * process on the same fake provider root.
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
  /** The api-only kernel that launches the task (it polls nothing). */
  let launcher: TestKernel;

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
    launcher = await startKernel(
      runConfig(
        { pg: h.dbUrl, redis: rdc.url },
        {
          roles: ["api"],
          extensions: [MODEL_FAKE, SANDBOX_FAKE],
          extensionConfig: { "sandbox-fake": { root } },
        },
      ),
    );
  });

  afterAll(async () => {
    if (db && launcher) {
      const rows = await db.selectFrom("device_instances").select("device_id").execute();
      for (const r of rows)
        await launcher.app
          .get(SandboxService)
          .destroyDevice(r.device_id)
          .catch(() => {});
    }
    await launcher?.close();
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("a task finishing while both replicas poll gets exactly one finish event", async () => {
    expect(h.replicas.map((r) => r.roles.includes("worker"))).toEqual([true, true]);
    const c = await seedConversation(raw);
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${c.orgId}, ${c.accountId}, 'owner')`.execute(raw);
    const deviceId = await seedDevice(raw, c.orgId, c.accountId);
    await db
      .updateTable("conversations")
      .set({ device_id: deviceId })
      .where("id", "=", c.conversationId)
      .execute();
    const run = await startClaimedRun(launcher, raw, c.conversationId, c.accountId);
    const t0 = Date.now();
    const task = await launchManaged(launcher, raw, { ...c, ...run }, "sleep 4; echo done", 60);
    const store = launcher.app.get(BackgroundTaskStore);
    const finished = await waitFor(
      async () => {
        const r = await store.get(task.id);
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
      taskId: task.id,
      status: "completed",
      lastLines: "done\n",
    });
  });
});
