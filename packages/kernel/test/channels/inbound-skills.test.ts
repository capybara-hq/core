import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SKILL_INVOCATION_LIMITS } from "@capybara-hq/plugin-sdk";
import {
  fakeDm as dm,
  type FakeChannelServer,
  fakeExtensionEntry,
  fakeGroupMessage as group,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_QUEUE_NAME, inboundJobId } from "../../src/channels/outbound.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { seedForkedSkill } from "../helpers/forked-skills.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Phase D Task 8 (spec §9): `/name args` in IM channels. After the extension strips the bot
 * mention, a message whose text is `/name args` naming a skill the bound person may invoke on the
 * connection's agent is posted as an invocation (the kernel path the web uses); `/new` stays
 * reserved in direct messages; anything else, or a skill that went away, is posted as plain text.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SOURCE = "chan-mini:t1";

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let connId: string;
let queue: Queue;
const skillIds: Record<string, string> = {};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** An org skill version written directly (SKILL.md in storage). */
async function seedSkill(
  name: string,
  body: string,
  invocation?: SkillManifest["invocation"],
): Promise<string> {
  const prefix = `skills/${randomUUID()}/`;
  const data = new TextEncoder().encode(
    `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`,
  );
  await k.storage.kernel(orgId).put(`${prefix}SKILL.md`, data, {
    contentType: "application/octet-stream",
    size: data.byteLength,
  });
  const manifest: SkillManifest = {
    name,
    description: `Use for ${name} work.`,
    files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
    ...(invocation !== undefined && { invocation }),
  };
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: orgId,
      scope: "org",
      agent_id: null,
      name,
      description: manifest.description,
      current_version: 1,
      created_by: ownerId,
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify(manifest),
      object_prefix: prefix,
      created_by: ownerId,
    })
    .execute();
  return id;
}

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CHAN_MINI, OBJECT_STORE],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000 },
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES (${SOURCE}, ${"u-owner"}, ${ownerId})`.execute(raw);
  skillIds["fix-issue"] = await seedSkill("fix-issue", "Fix GitHub issue $ARGUMENTS.");
  skillIds.new = await seedSkill("new", "A skill named new.");
  skillIds.hidden = await seedSkill("hidden", "Model only.", { model: true, user: false });
  skillIds.gone = await seedSkill("gone", "Soon deselected.");
  skillIds.review = (
    await seedForkedSkill(
      { db, storage: k.storage, orgId, ownerId },
      "review",
      "Review $ARGUMENTS.",
    )
  ).id;
  const agent = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
        skills: { orgSkills: Object.values(skillIds) },
      },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  const agentId = (agent.json() as { agent: { id: string } }).agent.id;
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  connId = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
}, 180_000);

afterAll(async () => {
  await queue?.close();
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

type UserMessage = ConversationEvent & {
  type: "user_message";
  payload: EventPayload<"user_message">;
};

/** Pushes a message and waits until its inbound job is done; returns the conversation's id. */
async function push(e: Parameters<FakeChannelServer["push"]>[1]): Promise<string> {
  expect(im.push(connId, e)).toBe(1);
  const id = (e as { messageId: string }).messageId;
  await waitFor(
    async () => (await queue.getJobState(inboundJobId(connId, id))) === "completed",
    15_000,
    `inbound job ${id}`,
  );
  const row = await db
    .selectFrom("conversation_events")
    .select("conversation_id")
    .where("idem_key", "like", `%${connId}:${id}`)
    .executeTakeFirst();
  return row?.conversation_id ?? "";
}

/** The user message the IM message `messageId` wrote (its `clientMessageId` idem key). */
async function written(conv: string, messageId: string): Promise<UserMessage> {
  const row = await db
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conv)
    .where("idem_key", "like", `%${connId}:${messageId}`)
    .executeTakeFirstOrThrow();
  return (await eventsOf(db, conv)).find(
    (e): e is UserMessage => e.type === "user_message" && e.seq === Number(row.seq),
  ) as UserMessage;
}

const firstText = (m: UserMessage) => {
  const b = m.payload.content[0];
  return b?.type === "text" ? b.text : "";
};

describe("skill invocations from IM (phase D Task 8)", { timeout: 60_000 }, () => {
  it("@bot /fix-issue 7 in a group thread invokes the skill with the rest as arguments", async () => {
    const conv = await push(group("g-fix", "u-owner", "/fix-issue 7"));
    const m = await written(conv, "g-fix");
    expect(m.payload.skill).toMatchObject({ name: "fix-issue", arguments: "7", mode: "inline" });
    expect(firstText(m)).toContain("Fix GitHub issue 7.");
  });

  it("a direct message /fix-issue 7 does the same", async () => {
    const conv = await push(dm("d-fix", "u-owner", "/fix-issue 7"));
    const m = await written(conv, "d-fix");
    expect(m.payload.skill).toMatchObject({ name: "fix-issue", arguments: "7" });
  });

  it("a direct message /new still starts a new conversation although a skill is named new", async () => {
    const before = im.sent.length;
    expect(im.push(connId, dm("d-new", "u-owner", "/new"))).toBe(1);
    await waitFor(
      async () => (await queue.getJobState(inboundJobId(connId, "d-new"))) === "completed",
      15_000,
      "inbound /new",
    );
    const reply = im.sent.slice(before).find((s) => s.target.chatId === "dm-u-owner");
    expect(reply?.message.text).toMatch(/new conversation/i);
    const rows = await db
      .selectFrom("conversation_events")
      .select("seq")
      .where("idem_key", "like", `%${connId}:d-new`)
      .execute();
    expect(rows).toEqual([]);
  });

  it("/unknown x, /hidden x (not user-invocable) and /etc/hosts are posted as plain text", async () => {
    for (const [id, text] of [
      ["d-unknown", "/unknown x"],
      ["d-hidden", "/hidden x"],
      ["d-path", "/etc/hosts"],
    ] as const) {
      const conv = await push(dm(id, "u-owner", text));
      const m = await written(conv, id);
      expect(m.payload.skill, id).toBeUndefined();
      expect(firstText(m), id).toBe(text);
    }
  });

  it("arguments over the limit: posted as text, and the bot says the skill did not run (batch 4 review m2)", async () => {
    const before = im.sent.length;
    const text = `/fix-issue ${"x".repeat(SKILL_INVOCATION_LIMITS.argumentsMaxChars + 1)}`;
    const conv = await push(dm("d-long", "u-owner", text));
    const m = await written(conv, "d-long");
    expect(m.payload.skill).toBeUndefined();
    expect(firstText(m)).toBe(text);
    const notes = im.sent
      .slice(before)
      .filter((s) => s.target.chatId === "dm-u-owner" && s.message.text.includes("not run"));
    expect(notes.map((s) => s.message.text)).toEqual([
      "The skill was not run: its arguments or instructions are too long. Your message was sent as plain text.",
    ]);
  });

  it("the note is best-effort: a failed send of it does not fail the inbound job (batch 5 review m4)", async () => {
    im.failNext("/send", 403, 1, undefined, "target_gone");
    const text = `/fix-issue ${"y".repeat(SKILL_INVOCATION_LIMITS.argumentsMaxChars + 1)}`;
    // push waits for the job to complete (a thrown non-retryable send would fail it)
    const conv = await push(dm("d-long-2", "u-owner", text));
    const m = await written(conv, "d-long-2");
    expect(firstText(m)).toBe(text);
    // the thread is bound for the agent's reply
    const delivery = await db
      .selectFrom("channel_deliveries")
      .select("connection_id")
      .where("conversation_id", "=", conv)
      .executeTakeFirst();
    expect(delivery?.connection_id).toBe(connId);
  });

  it("an unknown command gets no such note", async () => {
    const before = im.sent.length;
    const conv = await push(dm("d-unknown-2", "u-owner", "/unknown y"));
    await written(conv, "d-unknown-2");
    expect(im.sent.slice(before).some((s) => s.message.text.includes("skill was not run"))).toBe(
      false,
    );
  });

  it("a skill that went away between the parse and the post is posted as plain text", async () => {
    // the conversation's agent no longer selects the skill: the kernel refuses the invocation
    // (400 skill.not_invocable) and the message is posted as typed, never lost
    await db
      .deleteFrom("skill_versions")
      .where("skill_id", "=", skillIds.gone as string)
      .execute();
    await db
      .deleteFrom("skills")
      .where("id", "=", skillIds.gone as string)
      .execute();
    const conv = await push(dm("d-gone", "u-owner", "/gone now"));
    const m = await written(conv, "d-gone");
    expect(m.payload.skill).toBeUndefined();
    expect(firstText(m)).toBe("/gone now");
  });

  it("a fork invocation from IM runs its sub-agent and the agent's reply reaches the thread", async () => {
    const before = im.sent.length;
    const conv = await push(group("g-review", "u-owner", "/review src", { chatId: "grp-9" }));
    const m = await written(conv, "g-review");
    expect(m.payload.skill).toMatchObject({ name: "review", mode: "fork" });
    await waitFor(
      async () =>
        (await eventsOf(db, conv)).some((e) => e.type === "skill_fork_result") &&
        (await eventsOf(db, conv)).some((e) => e.type === "run_finished"),
      30_000,
      "fork run finished",
    );
    const reply = await waitFor(
      async () =>
        im.sent
          .slice(before)
          .find((s) => s.target.chatId === "grp-9" && s.target.threadId === "g-review"),
      15_000,
      "reply in the thread",
    );
    expect(reply?.message.text.length).toBeGreaterThan(0);
  });
});
