import { fileURLToPath } from "node:url";
import type { ChannelCard } from "@capybara-hq/plugin-sdk";
import {
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { personFieldParams, secretFieldsOf } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
} from "../helpers/runs.js";

/**
 * A Platform call whose target has secret fields is web-only: a channel-bound conversation gets a
 * `bind` card (the count and the conversation link), never an approval card; an ordinary approval
 * still gets its card (platform web parity spec, Task 6).
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const OP = "platform.probe-secrets";

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    apiKey: { type: "string", "x-secret": true, title: "API key" },
    token: { type: "string", "x-secret": true, title: "Token" },
  },
};

const probe = defineOperation({
  id: OP,
  description: "Test only: stores a probe config.",
  input: z.object({
    values: z.record(z.string(), z.unknown()).default({}),
    askPerson: personFieldParams.askPerson,
    clearSecrets: personFieldParams.clearSecrets,
  }),
  example: { values: {}, askPerson: ["apiKey", "token"], clearSecrets: [] },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "personal",
  summary: () => ({ zh: "保存探针配置", en: "Save the probe config" }),
  personFields: async () => ({
    target: { zh: "探针配置", en: "Probe config" },
    ...secretFieldsOf(TARGET_SCHEMA, new Set()),
  }),
  run: async () => ({ stored: true }),
}) as PlatformOperation;

const PROBE_CALL = `tool:Platform:${JSON.stringify({
  action: "call",
  operation: OP,
  params: { askPerson: ["apiKey", "token"] },
})}`;
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let connId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CHAN_MINI, MEM_CONNECTOR],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
      },
    ),
  );
  k.app.get(PlatformOperations).register([probe]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  const owner: Req = await session(k, "owner");
  const orgId = await createOrgWithProviders(k, owner);
  for (const plugin of ["chan-mini", "mem-connector"]) {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  const ag = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  const agentId = (ag.json() as { agent: { id: string } }).agent.id;
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "chan-mini",
      agentId,
      unboundPolicy: "bind",
      config: { platformUrl: im.url, appId: "cli_pf", appSecret: "app-secret-1234567" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  connId = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
});

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const sentTo = (chatId: string) => im.sent.filter((s) => s.target.chatId === chatId);
const cardOf = (s: FakeChannelSent) => s.message.cards?.[0] as ChannelCard | undefined;

async function convOf(chatId: string): Promise<string> {
  return waitFor(
    async () => {
      const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${connId} AND chat_id = ${chatId}
          AND archived_at IS NULL`.execute(raw);
      return r.rows[0]?.conversation_id;
    },
    10_000,
    "conversation",
  );
}

describe("approvals in IM: person fields", () => {
  it("two person fields: a bind card with the count and the conversation link, no approval card", async () => {
    im.push(connId, dm("pf1", "u-owner", PROBE_CALL));
    const conv = await convOf("dm-u-owner");
    await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    const sent = await waitFor(
      async () => sentTo("dm-u-owner").find((s) => cardOf(s)?.kind === "bind"),
      10_000,
      "bind card",
    );
    expect(cardOf(sent)).toEqual({
      kind: "bind",
      // the DM carries no locale: the org default (en); zh is covered by the unit test
      text: "2 fields to fill in on the web",
      url: `https://cap.example/chat/${conv}`,
    });
    expect(sentTo("dm-u-owner").some((s) => cardOf(s)?.kind === "approval")).toBe(false);
  });

  it("an ordinary approval still sends the approval card", async () => {
    const before = sentTo("dm-u-owner").length;
    im.push(connId, dm("pf2", "u-owner", "/new"));
    await waitFor(async () => sentTo("dm-u-owner").length > before, 10_000, "new conversation");
    im.push(connId, dm("pf3", "u-owner", ECHO));
    const sent = await waitFor(
      async () => im.sent.find((s) => cardOf(s)?.kind === "approval"),
      10_000,
      "approval card",
    );
    expect(cardOf(sent)).toMatchObject({ kind: "approval", state: "pending" });
  });

  it("the person-field approval stays pending and records no approval card (nothing to update on a decision)", async () => {
    const rows = await db
      .selectFrom("approvals")
      .select(["id", "status"])
      .where("tool_key", "=", `Platform:${OP}`)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    const cards = await sql<{ n: string }>`SELECT count(*) AS n FROM capybara.channel_card_messages
      WHERE card_kind = 'approval' AND card_id = ${rows[0]?.id as string}`.execute(raw);
    expect(Number(cards.rows[0]?.n)).toBe(0);
  });

  it("the bind card is delivered once", () => {
    expect(im.sent.filter((s) => cardOf(s)?.kind === "bind")).toHaveLength(1);
  });

  it("the ordinary approval card is recorded for decision updates", async () => {
    const sent = im.sent.find((s) => cardOf(s)?.kind === "approval");
    const id = (cardOf(sent as FakeChannelSent) as { id: string }).id;
    const cards = await sql<{ n: string }>`SELECT count(*) AS n FROM capybara.channel_card_messages
      WHERE card_kind = 'approval' AND card_id = ${id}`.execute(raw);
    expect(Number(cards.rows[0]?.n)).toBe(1);
  });

  it("the bind card counts the fields the approval stores", async () => {
    const row = await db
      .selectFrom("approvals")
      .select("detail")
      .where("tool_key", "=", `Platform:${OP}`)
      .executeTakeFirstOrThrow();
    expect((row.detail as { personFields: unknown[] }).personFields).toHaveLength(2);
  });
});
