import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  fakeDm as dm,
  type FakeChannelServer,
  fakeExtensionEntry,
  fakeGroupMessage as group,
  type Harness,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_QUEUE_NAME } from "../../src/channels/outbound.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { enableExtensions, eventsOf, PW, waitFor } from "../helpers/runs.js";

/**
 * Channel file delivery across replicas (spec §4.6): the replica uploading a file dies before the
 * platform answers, and the other replica resends it with the same idempotency key, so the chat
 * shows the file once; a replica that stops while a delivery waits for a file slot hands the job
 * back without a link line, and another replica delivers the file. Both replicas share PG, Redis
 * and the object store (`fake-object-store` on SeaweedFS); the job lock, stalled detection and the
 * delivery lease are shortened to 2 s / 1 s / 3 s.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const GENERATE = 'tool:GenerateImage:{"prompt":"x"}';
/** The text of a link line standing in for a file (spec §4.4). */
const LINK = "is in the web conversation";

let pgc: TestContainer;
let rdc: TestContainer;
let s3: TestS3;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
});

type Json = Record<string, unknown>;

/**
 * Two replicas (`roles` per replica), an org with chan-mini and the image purpose on model-fake,
 * an agent that may only call GenerateImage, and a chan-mini channel on `platform`.
 */
async function bootstrap(
  platform: FakeChannelServer,
  opts: { roles?: [string[], string[]]; fileConcurrency?: number } = {},
) {
  const redis = new Redis(rdc.url);
  cleanups.push(() => redis.disconnect());
  await redis.flushdb();
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE, OBJECT_STORE, CHAN_MINI],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    ...(opts.roles && { roles: opts.roles }),
    extensionConfig: {
      "fake-object-store": {
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        accessKeyId: s3.accessKey,
        secretAccessKey: s3.secretKey,
        forcePathStyle: true,
      },
      "model-fake": {
        models: [{ id: "fake-1" }, { id: "fake-image", kind: "image_generation" }],
      },
    },
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: {
        leaseTtlMs: 3000,
        scanIntervalMs: 300,
        ...(opts.fileConcurrency !== undefined && { fileConcurrency: opts.fileConcurrency }),
      },
      runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
    },
  });
  const harness = h;
  const raw = createDb(harness.dbUrl, 3);
  cleanups.push(() => raw.destroy());
  const db: KernelSchemaDb = kernelDb(raw);

  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await harness.request(path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (path === "/api/v1/auth/login") {
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
  };

  const ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  expect((await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status).toBe(
    200,
  );
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  const orgId = (org.json.org as { id: string }).id;
  await enableExtensions(raw, orgId, "model-fake");
  const base = `/api/v1/orgs/${orgId}`;
  expect((await call("PUT", `${base}/extensions/chan-mini`, { enabled: true })).status).toBe(200);
  const mapped = await call("PUT", `${base}/model-purposes/image`, {
    target: { model: { provider: "model-fake", model: "fake-image" }, params: {} },
  });
  expect(mapped.status, JSON.stringify(mapped.json)).toBe(200);
  const ag = await call("POST", `${base}/agents`, {
    definition: {
      name: "Painter",
      instructions: "Draw what is asked.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "GenerateImage" }]),
    },
    visibility: "org",
  });
  expect(ag.status, JSON.stringify(ag.json)).toBe(201);
  const agentId = (ag.json.agent as { id: string }).id;
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  const ch = await call("POST", `${base}/channels`, {
    plugin: "chan-mini",
    name: "Bot",
    agentId,
    config: { platformUrl: platform.url, appId: "cli_files", appSecret: "files-secret-0a1b2c3d" },
  });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  const connId = (ch.json.channel as { id: string }).id;
  await waitFor(async () => platform.active(connId)[0], 15_000, "long connection");

  /** The conversation bound to `chatId`. */
  const convOf = (chatId: string) =>
    waitFor(
      async () =>
        (
          await sql<{ conversation_id: string }>`SELECT conversation_id
            FROM capybara.channel_threads WHERE connection_id = ${connId} AND chat_id = ${chatId}
              AND archived_at IS NULL`.execute(raw)
        ).rows[0]?.conversation_id,
      20_000,
      `conversation of ${chatId}`,
    );
  /** No run of the conversation is queued or running. */
  const runsDone = async (conv: string) =>
    !(await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst());
  /** No run active and the delivery caught up with the log. */
  const caughtUp = (conv: string) =>
    waitFor(
      async () => {
        if (!(await runsDone(conv))) return false;
        const d = await db
          .selectFrom("channel_deliveries")
          .select("last_seq")
          .where("conversation_id", "=", conv)
          .executeTakeFirst();
        const c = await db
          .selectFrom("conversations")
          .select("last_seq")
          .where("id", "=", conv)
          .executeTakeFirstOrThrow();
        return d !== undefined && d.last_seq === c.last_seq;
      },
      60_000,
      "delivery caught up",
    );
  return { harness, db, connId, convOf, runsDone, caughtUp };
}

describe("channel file delivery (dual replica)", () => {
  it("the replica uploading a file dies; the other replica resends it with the same key and the chat shows one file", async () => {
    // dedupes uploads by idempotency key (like Lark's uuid): a resend with the same key is visible
    // as a duplicate, a resend with another key as a second file
    const platform = await startFakeChannelServer();
    cleanups.push(() => platform.stop());
    const { harness, db, connId, convOf, caughtUp } = await bootstrap(platform);
    const chat = "dm-u-owner";
    const files = () => platform.sentFiles.filter((f) => f.target.chatId === chat);

    // The upload reaches the platform, but the uploading replica never sees the response
    platform.delayNext("/send-file", 30_000);
    expect(platform.push(connId, dm("f1", "u-owner", GENERATE))).toBe(1);
    const first = await waitFor(async () => files()[0], 30_000, "the uploaded file");
    expect(first.kind).toBe("image");
    const victim = harness.replicas.find((r) => r.pid === first.pid);
    const survivor = harness.replicas.find((r) => r.pid !== first.pid);
    if (!victim || !survivor) throw new Error("cannot identify the uploading replica");
    await harness.kill(victim.index);

    // The survivor resends the file with the same key; the platform keeps one
    const resend = await waitFor(
      async () => platform.duplicateFiles.find((f) => f.pid === survivor.pid),
      60_000,
      "the resend from the surviving replica",
    );
    expect(resend.idempotencyKey).toBe(first.idempotencyKey);
    expect(resend.sha256).toBe(first.sha256);
    const conv = await convOf(chat);
    await caughtUp(conv);
    expect(files()).toHaveLength(1);
    // the reply after the image reached the chat once, after the file, and no link line stood in
    const texts = platform.sent.filter((s) => s.target.chatId === chat);
    const replies = texts.filter((s) => platform.finalText(s).startsWith("Tool result"));
    expect(replies).toHaveLength(1);
    expect(texts.some((s) => platform.finalText(s).includes(LINK))).toBe(false);
    // the log holds one artifact: the one delivered
    const artifacts = (await eventsOf(db, conv)).filter((e) => e.type === "artifact_created");
    expect(artifacts).toHaveLength(1);
  });

  it("a replica stops while a delivery waits for a file slot: the job is handed back without a link line and another replica delivers the file", async () => {
    const platform = await startFakeChannelServer();
    cleanups.push(() => platform.stop());
    // Only replica 0 consumes queues, with one file slot; replica 1 keeps the API and the gateway
    const { harness, db, connId, convOf, runsDone, caughtUp } = await bootstrap(platform, {
      roles: [
        ["api", "worker", "gateway"],
        ["api", "gateway"],
      ],
      fileConcurrency: 1,
    });
    const queueRedis = new Redis(rdc.url, { maxRetriesPerRequest: null });
    const queue = new Queue<{ conversationId?: string }>(CHANNEL_QUEUE_NAME, {
      connection: queueRedis,
    });
    cleanups.push(async () => {
      await queue.close();
      await queueRedis.quit().catch(() => undefined);
    });
    const filesTo = (chatId: string) =>
      platform.sentFiles.filter((f) => f.target.chatId === chatId);
    const textsTo = (chatId: string) => platform.sent.filter((s) => s.target.chatId === chatId);
    const jobsOf = async (conv: string, states: ("active" | "waiting" | "delayed")[]) =>
      (await queue.getJobs(states)).filter((j) => j.data.conversationId === conv);

    // Chat A's upload holds replica 0's only slot (its response never comes back in time)
    platform.delayNext("/send-file", 30_000);
    platform.push(connId, group("a1", "u-owner", GENERATE, { chatId: "grp-a" }));
    const held = await waitFor(async () => filesTo("grp-a")[0], 30_000, "chat A's upload");
    expect(held.pid).toBe(harness.replicas[0].pid);
    const convA = await convOf("grp-a");

    // Chat B's image waits for the slot: its run ended, its delivery job is active, and nothing
    // after the image (the reply) has reached the chat
    platform.push(connId, group("b1", "u-owner", GENERATE, { chatId: "grp-b" }));
    const convB = await convOf("grp-b");
    await waitFor(
      async () =>
        (await runsDone(convB)) &&
        (await runsDone(convA)) &&
        (await eventsOf(db, convB)).some((e) => e.type === "artifact_created") &&
        (await jobsOf(convB, ["active"])).length > 0,
      30_000,
      "chat B's delivery waiting for the file slot",
    );
    expect(textsTo("grp-b")).toHaveLength(0);
    expect(filesTo("grp-b")).toHaveLength(0);

    // Stop replica 0: chat B's delivery is handed back (not turned into a link line)
    await harness.stopReplica(0);
    // (a later event, such as the title's usage, may have queued a second job behind it)
    expect((await jobsOf(convB, ["waiting", "delayed"])).length).toBeGreaterThan(0);
    expect(textsTo("grp-b")).toHaveLength(0);
    expect(filesTo("grp-b")).toHaveLength(0);

    // Another replica delivers both: chat B's file once and natively, chat A's resent with its key
    const worker = await harness.startExtraReplica(["worker"]);
    await caughtUp(convB);
    await caughtUp(convA);
    const bFiles = filesTo("grp-b");
    expect(bFiles).toHaveLength(1);
    expect(bFiles[0]?.pid).toBe(worker.pid);
    expect(textsTo("grp-b").some((s) => platform.finalText(s).includes(LINK))).toBe(false);
    expect(
      textsTo("grp-b").filter((s) => platform.finalText(s).startsWith("Tool result")),
    ).toHaveLength(1);
    expect(filesTo("grp-a")).toHaveLength(1);
    expect(textsTo("grp-a").some((s) => platform.finalText(s).includes(LINK))).toBe(false);
  });
});
