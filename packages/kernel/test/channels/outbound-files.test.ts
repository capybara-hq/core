import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fakeDm as dm,
  FAKE_PNG_BASE64,
  type FakeChannelSent,
  type FakeChannelServer,
  fakeGroupMessage as group,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_QUEUE_NAME, deliverJobId, idempotencyKey } from "../../src/channels/outbound.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Channel file delivery spec §4.2-§4.5: every `artifact_created` of a conversation with a channel
 * target reaches the chat through `sendFile` (chan-mini: files up to 128 KiB, images up to
 * 32 KiB), or as one line linking to the web conversation (chan-noedit has no `sendFile`; a file
 * over the cap, an empty or missing one; a platform `too_large` / `rejected`).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const CHAN_MINI = fixture("chan-mini");
const CHAN_NOEDIT = fixture("chan-noedit");
const MEM_STORE = fixture("mem-store");
const PNG = Buffer.from(FAKE_PNG_BASE64, "base64");
const BASE = "https://cap.example";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let orgId: string;
let miniId: string;
let noEditId: string;
let events: QueueEvents;
let queue: Queue<{ conversationId?: string }>;
/** The clients handed to `events` / `queue` (BullMQ never closes a client it was given). */
const clients: Redis[] = [];
const client = (url: string) => {
  const c = new Redis(url, { maxRetriesPerRequest: null });
  clients.push(c);
  return c;
};
/** Ids of completed channel jobs (BullMQ removes them on completion). */
const completed = new Set<string>();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, MEM_STORE, CHAN_MINI, CHAN_NOEDIT],
        http: { port: 0, publicUrl: BASE },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000, deliveryIdleMs: 1000 },
        extensionConfig: {
          "model-fake": {
            models: [{ id: "fake-1" }, { id: "fake-image", kind: "image_generation" }],
          },
        },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  events = new QueueEvents(CHANNEL_QUEUE_NAME, {
    connection: client(rd.url),
  });
  events.on("completed", ({ jobId }) => completed.add(jobId));
  await events.waitUntilReady();
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: client(rd.url) });
  const ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  for (const plugin of ["chan-mini", "chan-noedit"]) {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  const mapped = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/image`,
    payload: { target: { model: { provider: "model-fake", model: "fake-image" }, params: {} } },
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
  const ag = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Painter",
        instructions: "Draw what is asked.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "GenerateImage" }]),
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  const agentId = (ag.json() as { agent: { id: string } }).agent.id;
  for (const source of ["chan-mini:t1", "chan-noedit:t1"]) {
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES (${source}, 'u-owner', ${ownerId})`.execute(raw);
  }
  const mk = async (plugin: string, appId: string) => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin,
        name: plugin,
        agentId,
        config: { platformUrl: im.url, appId, appSecret: "app-secret-1234567" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(id).length === 1, 10_000, `${plugin} long connection`);
    return id;
  };
  miniId = await mk("chan-mini", "cli_files");
  noEditId = await mk("chan-noedit", "cli_files_noedit");
});

afterAll(async () => {
  await events?.close();
  await queue?.close();
  await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const filesTo = (chatId: string) => im.sentFiles.filter((f) => f.target.chatId === chatId);
const textsTo = (chatId: string) => im.sent.filter((s) => s.target.chatId === chatId);
const linkLine = (name: string, size: string, conv: string, artifactId: string) =>
  `\`${name}\` (${size}) is in the web conversation: ${BASE}/chat/${conv}#file=${artifactId}`;

/** The conversation bound to a chat (its thread row). */
async function convOf(conn: string, chatId: string): Promise<string> {
  return waitFor(
    async () => {
      const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${conn} AND chat_id = ${chatId}
          AND archived_at IS NULL`.execute(raw);
      return r.rows[0]?.conversation_id;
    },
    10_000,
    "conversation",
  );
}

async function deliveredSeq(conv: string): Promise<number> {
  const r = await db
    .selectFrom("channel_deliveries")
    .select("last_seq")
    .where("conversation_id", "=", conv)
    .executeTakeFirst();
  return r ? Number(r.last_seq) : -1;
}

async function logSeq(conv: string): Promise<number> {
  const r = await db
    .selectFrom("conversations")
    .select("last_seq")
    .where("id", "=", conv)
    .executeTakeFirstOrThrow();
  return Number(r.last_seq);
}

async function lastError(connectionId: string): Promise<string | null> {
  const r = await db
    .selectFrom("channel_connections")
    .select("last_error")
    .where("id", "=", connectionId)
    .executeTakeFirstOrThrow();
  return r.last_error;
}

const clearError = (connectionId: string) =>
  sql`UPDATE capybara.channel_connections SET last_error = NULL WHERE id = ${connectionId}`.execute(
    raw,
  );

/** No run active and the delivery caught up with the log. */
async function caughtUp(conv: string): Promise<void> {
  await waitFor(
    async () => {
      const active = await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conv)
        .where("status", "in", ["queued", "running"])
        .executeTakeFirst();
      return !active && (await deliveredSeq(conv)) === (await logSeq(conv));
    },
    20_000,
    "delivery caught up",
  );
}

/** No delivery job of the conversation is waiting or running (an idle job also holds its lock). */
const noJobs = (conv: string) =>
  waitFor(
    async () => {
      const jobs = await queue.getJobs(["active", "waiting", "prioritized", "delayed"]);
      return jobs.every((j) => j.data.conversationId !== conv);
    },
    20_000,
    "no delivery job of the conversation left",
  );

/**
 * The delivery job owed for log position `seq` completed and no job of the conversation is left
 * (a job writes `last_error` only after it released the conversation lock).
 */
async function jobsDone(conv: string, seq: number): Promise<void> {
  await waitFor(async () => completed.has(deliverJobId(conv, seq)), 20_000, "delivery job done");
  await noJobs(conv);
}

/** Starts a group conversation in `chatId` on `conn` and waits until its reply is delivered. */
async function groupConv(conn: string, chatId: string): Promise<string> {
  im.push(conn, group(`m-${chatId}`, "u-owner", "echo:ready", { chatId }));
  const conv = await convOf(conn, chatId);
  // the title's usage is logged after the run: a later event would resume a stopped delivery
  await waitFor(
    async () =>
      (await eventsOf(db, conv)).some(
        (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "title",
      ),
    20_000,
    "the title",
  );
  await caughtUp(conv);
  await waitFor(async () => textsTo(chatId).length > 0, 10_000, "first reply");
  // a stopped round resumes when a later event arrives during its attempt: start from rest
  await noJobs(conv);
  return conv;
}

interface Upload {
  name: string;
  bytes: Buffer;
  type: string;
  /** Remove the object again before the event is logged. */
  deleted?: boolean;
}

/** Stores objects and logs one `artifact_created` each, in one append (as `Deliver` does). */
async function deliverArtifacts(
  conv: string,
  files: Upload[],
): Promise<{ artifactId: string; seq: number }[]> {
  const store = k.app.get(StorageService).kernel(orgId);
  const made = [];
  for (const f of files) {
    const artifactId = randomUUID();
    const objectKey = `artifacts/${conv}/${artifactId}`;
    await store.put(objectKey, f.bytes, {
      contentType: f.type,
      size: f.bytes.byteLength,
      signal: AbortSignal.timeout(10_000),
    });
    if (f.deleted) await store.delete(objectKey);
    made.push({ artifactId, objectKey, f });
  }
  const logged = await k.app.get(EventLog).append(
    conv,
    made.map(({ artifactId, objectKey, f }) => ({
      type: "artifact_created" as const,
      payload: {
        artifactId,
        name: f.name,
        contentType: f.type,
        size: f.bytes.byteLength,
        objectKey,
        sourcePath: `/workspace/${f.name}`,
        callId: `call-${f.name}`,
      },
    })),
  );
  return made.map((m, i) => ({ artifactId: m.artifactId, seq: logged[i]?.seq as number }));
}

const deliverArtifact = async (conv: string, name: string, bytes: Buffer, type: string) =>
  (await deliverArtifacts(conv, [{ name, bytes, type }]))[0] as { artifactId: string; seq: number };

describe("channel file delivery", () => {
  it("a GenerateImage image in a DM reaches the chat as an image before the final reply", async () => {
    im.push(miniId, dm("img-1", "u-owner", 'tool:GenerateImage:{"prompt":"a cat"}'));
    const conv = await convOf(miniId, "dm-u-owner");
    await caughtUp(conv);
    const artifact = (await eventsOf(db, conv)).find((e) => e.type === "artifact_created");
    expect(artifact).toBeDefined();
    const seq = artifact?.seq as number;
    const files = filesTo("dm-u-owner");
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f).toMatchObject({
      kind: "image",
      contentType: "image/png",
      sha256: sha256(PNG),
      idempotencyKey: idempotencyKey(`${conv}-${seq}`),
    });
    const reply = textsTo("dm-u-owner").find((s: FakeChannelSent) =>
      im.finalText(s).startsWith("Tool result"),
    );
    expect(reply).toBeDefined();
    expect(f?.at).toBeLessThanOrEqual(reply?.at as number);
  });

  it("two artifacts of one append reach the group thread in log order", async () => {
    const chat = "grp-two";
    const conv = await groupConv(miniId, chat);
    const threadId = textsTo(chat)[0]?.target.threadId;
    expect(threadId).toBeDefined();
    const big = Buffer.alloc(40 * 1024, 7);
    const made = await deliverArtifacts(conv, [
      { name: "a.pdf", bytes: Buffer.alloc(1024, 1), type: "application/pdf" },
      { name: "b.png", bytes: big, type: "image/png" },
    ]);
    await caughtUp(conv);
    const files = filesTo(chat);
    expect(files.map((f) => [f.name, f.kind, f.target.threadId])).toEqual([
      ["a.pdf", "file", threadId],
      // over chan-mini's imageMaxBytes (32 KiB): sent as a file
      ["b.png", "file", threadId],
    ]);
    expect(files.map((f) => f.idempotencyKey)).toEqual(
      made.map((m) => idempotencyKey(`${conv}-${m.seq}`)),
    );
    expect(files[1]?.sha256).toBe(sha256(big));
  });

  it("a channel without sendFile gets one link line", async () => {
    const chat = "grp-noedit";
    const conv = await groupConv(noEditId, chat);
    const before = textsTo(chat).length;
    const a = await deliverArtifact(conv, "report.pdf", Buffer.alloc(1024, 2), "application/pdf");
    await caughtUp(conv);
    expect(filesTo(chat)).toHaveLength(0);
    const after = textsTo(chat).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.message.text).toBe(linkLine("report.pdf", "1.0 KB", conv, a.artifactId));
    expect(after[0]?.idempotencyKey).toBe(idempotencyKey(`${conv}-${a.seq}-link`));
  });

  it("a file over the channel cap and an empty file become link lines", async () => {
    const chat = "grp-caps";
    const conv = await groupConv(miniId, chat);
    const before = textsTo(chat).length;
    const made = await deliverArtifacts(conv, [
      { name: "huge.bin", bytes: Buffer.alloc(200 * 1024, 3), type: "application/octet-stream" },
      { name: "empty.txt", bytes: Buffer.alloc(0), type: "text/plain" },
    ]);
    await caughtUp(conv);
    expect(filesTo(chat)).toHaveLength(0);
    expect(
      textsTo(chat)
        .slice(before)
        .map((s) => s.message.text),
    ).toEqual([
      linkLine("huge.bin", "200.0 KB", conv, made[0]?.artifactId as string),
      linkLine("empty.txt", "0 B", conv, made[1]?.artifactId as string),
    ]);
    expect(await deliveredSeq(conv)).toBe(await logSeq(conv));
  });

  it("an object removed from storage before delivery becomes a link line", async () => {
    const chat = "grp-gone";
    const conv = await groupConv(miniId, chat);
    const before = textsTo(chat).length;
    const [a] = await deliverArtifacts(conv, [
      { name: "lost.pdf", bytes: Buffer.alloc(2048, 4), type: "application/pdf", deleted: true },
    ]);
    await caughtUp(conv);
    expect(filesTo(chat)).toHaveLength(0);
    expect(textsTo(chat).slice(before)[0]?.message.text).toBe(
      linkLine("lost.pdf", "2.0 KB", conv, a?.artifactId as string),
    );
  });

  it("too_large, rejected and a failure without a reason become link lines; the last two record last_error", async () => {
    const chat = "grp-refused";
    const conv = await groupConv(miniId, chat);
    const cases = [
      { status: 413, reason: "too_large" as const, records: false },
      { status: 400, reason: "rejected" as const, records: true },
      { status: 400, reason: undefined, records: true },
    ];
    for (const [i, c] of cases.entries()) {
      await clearError(miniId);
      im.failNext("/send-file", c.status, 1, undefined, c.reason, undefined, { chatId: chat });
      const before = textsTo(chat).length;
      const name = `doc-${i}.pdf`;
      const a = await deliverArtifact(conv, name, Buffer.alloc(1024, 5), "application/pdf");
      await caughtUp(conv);
      await jobsDone(conv, a.seq);
      const after = textsTo(chat).slice(before);
      expect(after.map((s) => s.message.text)).toEqual([
        linkLine(name, "1.0 KB", conv, a.artifactId),
      ]);
      expect(after[0]?.idempotencyKey).toBe(idempotencyKey(`${conv}-${a.seq}-link`));
      const err = await lastError(miniId);
      if (c.records) expect(err).toMatch(/^delivery failed:/);
      else expect(err).toBeNull();
    }
    expect(filesTo(chat)).toHaveLength(0);
  });

  it("a retryable 429 is retried with the same key and sent once", async () => {
    const chat = "grp-retry";
    const conv = await groupConv(miniId, chat);
    im.failNext("/send-file", 429, 1, 50, undefined, undefined, { chatId: chat });
    const a = await deliverArtifact(conv, "c.pdf", Buffer.alloc(1024, 6), "application/pdf");
    await caughtUp(conv);
    const files = filesTo(chat);
    expect(files).toHaveLength(1);
    expect(files[0]?.idempotencyKey).toBe(idempotencyKey(`${conv}-${a.seq}`));
  });

  it("target_gone stops the round without a link line", async () => {
    const chat = "grp-target-gone";
    const conv = await groupConv(miniId, chat);
    const before = textsTo(chat).length;
    im.failNext("/send-file", 404, 1, undefined, "target_gone", undefined, { chatId: chat });
    const a = await deliverArtifact(conv, "d.pdf", Buffer.alloc(1024, 8), "application/pdf");
    await jobsDone(conv, a.seq);
    expect(await deliveredSeq(conv)).toBeLessThan(a.seq);
    expect(textsTo(chat).slice(before)).toHaveLength(0);
    expect(filesTo(chat)).toHaveLength(0);
  });
});
