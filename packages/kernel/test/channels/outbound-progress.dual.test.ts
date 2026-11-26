import { fileURLToPath } from "node:url";
import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import {
  createDualReplicaHarness,
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  type Harness,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { enableExtensions, PW, waitFor } from "../helpers/runs.js";

/**
 * The progress card across replicas (process blocks spec §6.3): the worker delivering a run is
 * killed after its progress card was posted and edited; the other replica rebuilds the card's
 * state from the log and keeps editing the same message (its id is in `channel_deliveries`), and
 * the answer is sent once. Job locks and stalled detection shortened to 2 s / 1 s.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const LONG = "A progress card survives the replica that posted it and keeps being edited. ".repeat(
  3,
);

let pgc: TestContainer;
let rdc: TestContainer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await im?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;
type ProgressCard = Extract<ChannelCard, { kind: "progress" }>;
const progressOf = (s: FakeChannelSent | undefined) => {
  const c = s?.message.cards?.[0];
  return c?.kind === "progress" ? (c as ProgressCard) : undefined;
};

async function bootstrap(appId: string) {
  const redis = new Redis(rdc.url);
  cleanups.push(() => redis.disconnect());
  await redis.flushdb();
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE, CHAN_MINI],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: { leaseTtlMs: 3000, scanIntervalMs: 300 },
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
  const ag = await call("POST", `${base}/agents`, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: builtinsOff(),
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
    processDisplay: "detailed",
    config: { platformUrl: im.url, appId, appSecret: "progress-secret-0a1b2c" },
  });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  const connId = (ch.json.channel as { id: string }).id;
  await waitFor(async () => im.active(connId)[0], 15_000, "long connection");
  return { harness, raw, db, connId };
}

describe("channel progress card (two replicas)", () => {
  it("second replica resumes and edits the same progress message", async () => {
    const { harness, raw, db, connId } = await bootstrap("cli_prog");
    const chat = "dm-u-owner";
    const mine = () => im.sent.filter((s) => s.appId === "cli_prog" && s.target.chatId === chat);
    const updatesOf = (id: string) => im.updated.filter((u) => u.messageId === id);

    // a slow streamed answer: the card is posted, then edited with the streamed status line
    expect(im.push(connId, dm("p1", "u-owner", `slow:150:${LONG}`))).toBe(1);
    const card = await waitFor(
      async () => mine().find((s) => progressOf(s) !== undefined),
      20_000,
      "progress card",
    );
    await waitFor(
      async () => updatesOf(card.messageId).some((u) => progressOf(u)?.status !== undefined),
      20_000,
      "first progress edit",
    );
    const convId = (
      await sql<{ conversation_id: string }>`SELECT conversation_id FROM capybara.channel_threads
        WHERE connection_id = ${connId}`.execute(raw)
    ).rows[0]?.conversation_id as string;
    const row = () =>
      db
        .selectFrom("channel_deliveries")
        .select(["last_seq", "progress_message_id", "progress_run_id"])
        .where("conversation_id", "=", convId)
        .executeTakeFirstOrThrow();
    // the card's id was recorded with its run_started
    expect((await row()).progress_message_id).toBe(card.messageId);
    const victim = harness.replicas.find((r) => r.pid === card.pid);
    const survivor = harness.replicas.find((r) => r.pid !== card.pid);
    if (!victim || !survivor) throw new Error("cannot identify the delivering replica");
    await harness.kill(victim.index);

    // the survivor edits the same message down to its finished form
    const final = await waitFor(
      async () =>
        updatesOf(card.messageId).find(
          (u) => u.pid === survivor.pid && progressOf(u)?.state === "finished",
        ),
      40_000,
      "finished card from the surviving replica",
    );
    expect(progressOf(final)?.title).toMatch(/^Worked for /);
    await waitFor(
      async () => {
        const c = await db
          .selectFrom("conversations")
          .select("last_seq")
          .where("id", "=", convId)
          .executeTakeFirstOrThrow();
        return (await row()).last_seq === c.last_seq;
      },
      20_000,
      "delivery caught up",
    );
    // one progress message for the run, one answer, nothing else
    const all = mine();
    expect(all.filter((s) => progressOf(s) !== undefined)).toEqual([card]);
    expect(all.filter((s) => progressOf(s) === undefined).map((s) => s.message.text)).toEqual([
      LONG,
    ]);
    const r = await row();
    expect(r.progress_message_id).toBe(card.messageId);
    expect(r.progress_run_id).not.toBeNull();
  });
});
