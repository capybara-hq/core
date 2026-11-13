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
import { DevicesService } from "../../src/devices/devices.service.js";
import {
  LEGACY_CLEANUP_JOB,
  LegacySandboxCleanupJob,
} from "../../src/devices/legacy-cleanup.job.js";
import {
  createFakeSandbox,
  fakeFileSystems,
  fakeSandboxState,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * `DevicesService.setImDefault`: only the person's own live device in the org.
 *
 * The second suite is the cleanup of the per-conversation sandboxes (spec
 * 2026-11-07-environments-design §4.2 item 9): every row of the legacy `sandboxes` table has its
 * instance and file system `cap-<conversationId>` destroyed by its provider, then the row is
 * deleted; rows of a provider that is not loaded stay. Both suites share the fake sandbox and its
 * temp root.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let ownerId: string;
let owner: Req;
let orgId: string;
let fake: SandboxProvider;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-device-imdef-"));
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
  fake = createFakeSandbox(root);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function newDevice(req: Req, org: string, name: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${org}/devices`,
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { device: { id: string } }).device.id;
}

const rows = (org: string, account: string) =>
  db
    .selectFrom("device_defaults")
    .selectAll()
    .where("org_id", "=", org)
    .where("account_id", "=", account)
    .execute();

describe("setImDefault", () => {
  const service = () => k.app.get(DevicesService);

  it("sets the person's own live device", async () => {
    const id = await newDevice(owner, orgId, "Mine");
    await service().setImDefault(orgId, ownerId, id);
    expect(await service().imDefault(orgId, ownerId)).toBe(id);
    await db.deleteFrom("device_defaults").where("account_id", "=", ownerId).execute();
  });

  it("rejects another person's device", async () => {
    const login = `m-${randomUUID().slice(0, 8)}`;
    const other = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
      .id;
    await testMembers(db).add(orgId, other, "member", ownerId);
    const theirs = await newDevice(await session(k, login), orgId, "Theirs");
    await expect(service().setImDefault(orgId, ownerId, theirs)).rejects.toMatchObject({
      code: "device.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
  });

  it("rejects a deleted device", async () => {
    const id = await newDevice(owner, orgId, "Doomed");
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/devices/${id}` });
    expect(del.statusCode, del.body).toBeLessThan(300);
    await expect(service().setImDefault(orgId, ownerId, id)).rejects.toMatchObject({
      code: "device.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
  });

  it("rejects a device of another org", async () => {
    const otherOrg = await createOrg(owner, "Other");
    const elsewhere = await newDevice(owner, otherOrg, "Elsewhere");
    await expect(service().setImDefault(orgId, ownerId, elsewhere)).rejects.toMatchObject({
      code: "device.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
    expect(await rows(otherOrg, ownerId)).toHaveLength(0);
  });
});

const limits = {
  cpu: 1,
  memoryMb: 1,
  diskMb: 1,
  egress: "none" as const,
  allowHosts: [],
  tier: "strict" as const,
  devHosts: [],
};
const sig = () => AbortSignal.timeout(10_000);

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
    expect(LEGACY_CLEANUP_JOB).toBe("devices-legacy-cleanup");
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
