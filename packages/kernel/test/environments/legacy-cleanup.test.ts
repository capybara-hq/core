import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  LEGACY_CLEANUP_JOB,
  LegacySandboxCleanupJob,
} from "../../src/environments/legacy-cleanup.job.js";
import {
  createFakeSandbox,
  fakeFileSystems,
  fakeSandboxState,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { runConfig, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * The cleanup of the per-conversation sandboxes (spec 2026-11-07-environments-design §4.2 item 9):
 * every row of the legacy `sandboxes` table has its instance and file system `cap-<conversationId>`
 * destroyed by its provider, then the row is deleted; rows of a provider that is not loaded stay.
 * One kernel (worker role) with the fake sandbox; the provider objects of the test share its root.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const limits = { cpu: 1, memoryMb: 1, diskMb: 1, egress: "none" as const, allowHosts: [] };
const sig = () => AbortSignal.timeout(10_000);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let fake: SandboxProvider;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-env-legacy-"));
  fake = createFakeSandbox(root);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

/** A legacy row of `provider` with, on the fake provider, its file system and instance. */
async function legacySandbox(provider: string): Promise<{
  conversationId: string;
  instanceId: string;
  fileSystemId: string;
}> {
  const conversationId = randomUUID();
  const name = `cap-${conversationId}`;
  const fileSystem = await fake.createFileSystem({ name, limits, signal: sig() });
  const h = await fake.create({ name, limits, fileSystem, signal: sig() });
  await db
    .insertInto("sandboxes")
    .values({
      conversation_id: conversationId,
      org_id: randomUUID(),
      provider,
      handle: JSON.stringify(h),
      status: "running",
    })
    .execute();
  return { conversationId, instanceId: h.id, fileSystemId: fileSystem.id };
}

const legacyRows = async (ids: string[]) =>
  (
    await db
      .selectFrom("sandboxes")
      .select("conversation_id")
      .where("conversation_id", "in", ids)
      .execute()
  ).map((r) => r.conversation_id);

describe("legacy sandbox cleanup", () => {
  it("is a job name without ':'", () => {
    expect(LEGACY_CLEANUP_JOB).toBe("environments-legacy-cleanup");
  });

  it("legacy cleanup destroys old instances and volumes then deletes the rows", async () => {
    const a = await legacySandbox("sandbox-fake");
    const b = await legacySandbox("sandbox-fake");
    // a row without instance (stopped while creating): destroying by name still runs
    const c = randomUUID();
    await db
      .insertInto("sandboxes")
      .values({
        conversation_id: c,
        org_id: randomUUID(),
        provider: "sandbox-fake",
        status: "creating",
      })
      .execute();

    const job = k.app.get(LegacySandboxCleanupJob);
    const res = await job.runOnce();
    expect(res.destroyed).toBe(3);

    for (const s of [a, b]) {
      expect(await fakeSandboxState(root, s.instanceId)).toBeNull();
      expect(await fakeFileSystems(root)).not.toContain(s.fileSystemId);
    }
    const ops = (await readFakeSandboxOps(root)).map((o) => o.join(" "));
    for (const id of [a.conversationId, b.conversationId, c]) {
      expect(ops).toContain(`destroy-by-name cap-${id}`);
      expect(ops).toContain(`destroy-fs-by-name cap-${id}`);
    }
    expect(await legacyRows([a.conversationId, b.conversationId, c])).toEqual([]);

    // nothing left: the next run does nothing
    expect(await job.runOnce()).toEqual({ destroyed: 0, kept: 0 });
  });

  it("rows of an unloaded provider are kept", async () => {
    const gone = await legacySandbox("sandbox-retired");
    const live = await legacySandbox("sandbox-fake");

    const res = await k.app.get(LegacySandboxCleanupJob).runOnce();
    expect(res).toEqual({ destroyed: 1, kept: 1 });

    expect(await legacyRows([gone.conversationId, live.conversationId])).toEqual([
      gone.conversationId,
    ]);
    // the fake provider is not the row's provider: its instance and files are left alone
    expect(await fakeSandboxState(root, gone.instanceId)).toBe("running");
    expect(await fakeFileSystems(root)).toContain(gone.fileSystemId);
    expect(await fakeSandboxState(root, live.instanceId)).toBeNull();

    await db.deleteFrom("sandboxes").where("conversation_id", "=", gone.conversationId).execute();
  });
});
