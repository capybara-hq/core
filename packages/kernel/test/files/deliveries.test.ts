import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { FileDeliveries } from "../../src/files/deliveries.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { type ArtifactStoreDeps, storeArtifacts } from "../../src/tools/builtins/artifacts.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * File library spec §4 "Delivering": a delivered or generated file's bytes become a shared blob of
 * the org (an existing ready blob of the same sha256 is reused, no upload), and its
 * `artifact_created` event and its library file (owner the conversation's owner, the
 * conversation's agent, origin by source path) commit together. A real kernel with `mem-store`;
 * `storeArtifacts` is called directly against the real log and deliveries.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let otherId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fixture("mem-store")] },
    ),
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" })).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Deliverer",
        instructions: "Deliver files.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Artifact = ConversationEvent & {
  type: "artifact_created";
  payload: EventPayload<"artifact_created">;
};
const artifactsOf = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is Artifact => e.type === "artifact_created");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const deps = (deliveries?: ArtifactStoreDeps["deliveries"]): ArtifactStoreDeps => ({
  deliveries: deliveries ?? k.app.get(FileDeliveries),
  eventLog: k.app.get(EventLog),
});

/** A call of the run's account `accountId` (not necessarily the conversation's owner). */
const ctx = (conversationId: string, accountId = ownerId): BuiltinCallContext => ({
  orgId,
  accountId,
  agentId,
  conversationId,
  rootConversationId: conversationId,
  callId: `call-${randomUUID().slice(0, 8)}`,
  signal: new AbortController().signal,
});

const file = (text: string, sourcePath = "/workspace/report.txt", name = "report.txt") => ({
  name,
  contentType: "text/plain",
  data: new TextEncoder().encode(text),
  sourcePath,
});

/** Counts the kernel store's puts under `blobs/` from now on. */
function countBlobPuts(): { count: () => number } {
  const storage = k.app.get(StorageService);
  const original = storage.kernel.bind(storage);
  let puts = 0;
  vi.spyOn(storage, "kernel").mockImplementation((org) => {
    const s = original(org);
    return {
      ...s,
      put: async (key, body, opts) => {
        if (key.startsWith("blobs/")) puts += 1;
        return s.put(key, body, opts);
      },
    };
  });
  return { count: () => puts };
}

async function blobKeys(): Promise<string[]> {
  const r = await k.app.get(StorageService).kernel(orgId).list("blobs/");
  return r.items.map((o) => o.key);
}

describe("deliveries on shared blobs", () => {
  it("two conversations delivering identical bytes share one blob, written once", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    const before = await blobKeys();
    const puts = countBlobPuts();
    try {
      const [x] = await storeArtifacts(deps(), ctx(a), [file("shared bytes")]);
      const [y] = await storeArtifacts(deps(), ctx(b), [file("shared bytes")]);
      expect(puts.count()).toBe(1);
      const [ea] = await artifactsOf(a);
      const [eb] = await artifactsOf(b);
      expect(ea?.payload.objectKey).toBe(eb?.payload.objectKey);
      expect(ea?.payload.objectKey).toMatch(/^blobs\//);
      const rows = await db
        .selectFrom("files")
        .select(["id", "blob_id"])
        .where("org_id", "=", orgId)
        .where("id", "in", [x?.artifactId as string, y?.artifactId as string])
        .execute();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.blob_id)).size).toBe(1);
      expect((await blobKeys()).filter((key) => !before.includes(key))).toEqual([
        ea?.payload.objectKey,
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a delivery of bytes the org already holds puts nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await storeArtifacts(deps(), ctx(conv), [file("held already")]);
    const puts = countBlobPuts();
    try {
      const [again] = await storeArtifacts(deps(), ctx(conv), [file("held already")]);
      expect(again?.repeatOf).toBeUndefined();
      expect(puts.count()).toBe(0);
      expect(await artifactsOf(conv)).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the file is the conversation owner's, with its agent, origin by source path", async () => {
    const conv = await createConv(owner, orgId, agentId);
    // the call's account is another member: the file still belongs to the conversation's owner
    const stored = await storeArtifacts(deps(), ctx(conv, otherId), [
      file("delivered bytes", "/workspace/out/a.txt", "a.txt"),
      file("generated bytes", "generated/call-1/image.png", "image.png"),
    ]);
    const events = await artifactsOf(conv);
    expect(events.map((e) => e.payload.fileId)).toEqual(stored.map((s) => s.artifactId));
    const files = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select([
        "files.id",
        "files.account_id",
        "files.agent_id",
        "files.origin",
        "files.status",
        "files.name",
        "files.size",
        "files.source_conversation_id",
        "files.source_path",
        "blobs.object_key",
        "blobs.sha256",
      ])
      .where("files.org_id", "=", orgId)
      .where("files.source_conversation_id", "=", conv)
      .orderBy("files.name")
      .execute();
    expect(files).toEqual([
      {
        id: stored[0]?.artifactId,
        account_id: ownerId,
        agent_id: agentId,
        origin: "delivered",
        status: "ready",
        name: "a.txt",
        size: "15",
        source_conversation_id: conv,
        source_path: "/workspace/out/a.txt",
        object_key: events[0]?.payload.objectKey,
        sha256: sha("delivered bytes"),
      },
      {
        id: stored[1]?.artifactId,
        account_id: ownerId,
        agent_id: agentId,
        origin: "generated",
        status: "ready",
        name: "image.png",
        size: "15",
        source_conversation_id: conv,
        source_path: "generated/call-1/image.png",
        object_key: events[1]?.payload.objectKey,
        sha256: sha("generated bytes"),
      },
    ]);
    const refs = await db
      .selectFrom("conversation_files")
      .select(["file_id", "role", "first_seq"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conv)
      .orderBy("first_seq")
      .execute();
    expect(refs).toEqual(
      events.map((e) => ({
        file_id: e.payload.artifactId,
        role: "delivered",
        first_seq: `${e.seq}`,
      })),
    );
  });

  it("a blob a deletion claims before the delivery commits is replaced by fresh bytes", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const real = k.app.get(FileDeliveries);
    const claimed: string[] = [];
    const racing: ArtifactStoreDeps["deliveries"] = {
      ensureBlob: async (...args) => {
        const blob = await real.ensureBlob(...args);
        if (claimed.length === 0) {
          // the blob sweep claims it right after it was returned (unlocked)
          claimed.push(blob.id);
          await db
            .updateTable("blobs")
            .set({ status: "deleting" })
            .where("id", "=", blob.id)
            .where("org_id", "=", orgId)
            .execute();
        }
        return blob;
      },
      appendDelivered: (...args) => real.appendDelivered(...args),
    };
    const [stored] = await storeArtifacts(deps(racing), ctx(conv), [file("claimed bytes")]);
    // one event and one file, on the new blob; the rolled back attempt left nothing
    const events = await artifactsOf(conv);
    expect(events).toHaveLength(1);
    const row = await db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select(["blobs.id", "blobs.status", "blobs.object_key", "blobs.sha256"])
      .where("files.org_id", "=", orgId)
      .where("files.id", "=", stored?.artifactId as string)
      .executeTakeFirstOrThrow();
    expect(row.id).not.toBe(claimed[0]);
    expect(row).toMatchObject({ status: "ready", sha256: sha("claimed bytes") });
    expect(events[0]?.payload.objectKey).toBe(row.object_key);
  });
});
