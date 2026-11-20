import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationLeakCheck } from "../../src/conversations/leak-check.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createOrgWithProviders,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The leak check (platform web parity spec §4.5, R7): a value a person submits on an approval
 * card is refused when it already appears in the conversation tree's event log.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let check: ConversationLeakCheck;
let lines: string[];
let orgId: string;
let agentId: string;
let accountId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  lines = [];
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }), {
    env: {},
    logger: createLogger("debug", { write: (l) => lines.push(l) }),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  check = k.app.get(ConversationLeakCheck);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const a = await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  accountId = a.id;
  const req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  agentId = await createAgent(req, orgId);
});

async function conv(parent?: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("conversations")
    .values({
      id,
      org_id: orgId,
      agent_id: agentId,
      account_id: accountId,
      source: "web",
      ...(parent === undefined
        ? {}
        : { kind: "subagent" as const, parent_conversation_id: parent }),
    })
    .execute();
  return id;
}

async function event(conversationId: string, seq: number, type: string, payload: unknown) {
  await db
    .insertInto("conversation_events")
    .values({
      conversation_id: conversationId,
      seq: String(seq),
      type,
      payload: JSON.stringify({ type, ...(payload as object) }),
    })
    .execute();
}

describe("ConversationLeakCheck", () => {
  it("finds a value in a user message", async () => {
    const c = await conv();
    await event(c, 1, "user_message", {
      content: [{ type: "text", text: "my key is sk-live-12345678" }],
    });
    expect(
      await check.leaked(c, { apiKey: "sk-live-12345678", other: "never-seen-value" }),
    ).toEqual(["apiKey"]);
  });

  it("finds a value in a sub-agent's tool result, asked from the root or from a sibling", async () => {
    const root = await conv();
    const a = await conv(root);
    const b = await conv(root);
    const deep = await conv(a);
    await event(deep, 1, "tool_result", { output: "token=sk-deep-98765432" });
    expect(await check.leaked(root, { k: "sk-deep-98765432" })).toEqual(["k"]);
    expect(await check.leaked(b, { k: "sk-deep-98765432" })).toEqual(["k"]);
  });

  it("finds a value inside a longer token in an assistant message", async () => {
    const c = await conv();
    await event(c, 1, "assistant_message", {
      content: [{ type: "text", text: "xxabcd1234efghyy" }],
    });
    expect(await check.leaked(c, { k: "abcd1234efgh" })).toEqual(["k"]);
  });

  it("finds a value containing quotes and backslashes (stored JSON-escaped)", async () => {
    const c = await conv();
    const value = 'pa"ss\\word\nline';
    await event(c, 1, "tool_result", { output: `value ${value} end` });
    expect(await check.leaked(c, { k: value })).toEqual(["k"]);
  });

  it("finds a value with non-ASCII and control characters (stored JSON-escaped)", async () => {
    const c = await conv();
    const value = "密码-ü-\t-12345";
    await event(c, 1, "user_message", { content: [{ type: "text", text: `key ${value} end` }] });
    expect(await check.leaked(c, { k: value })).toEqual(["k"]);
    expect(await check.leaked(c, { k: "密码-ü-\t-54321" })).toEqual([]);
  });

  it("does not match a value that is only in another conversation", async () => {
    const a = await conv();
    const other = await conv();
    await event(other, 1, "user_message", {
      content: [{ type: "text", text: "sk-other-12345678" }],
    });
    expect(await check.leaked(a, { k: "sk-other-12345678" })).toEqual([]);
  });

  it("never matches a value shorter than 8 characters", async () => {
    const c = await conv();
    await event(c, 1, "user_message", { content: [{ type: "text", text: "pw=1234567 end" }] });
    expect(await check.leaked(c, { k: "1234567" })).toEqual([]);
  });

  it("logs no value", async () => {
    const c = await conv();
    const secret = "sk-logcheck-ZZ-424242";
    await event(c, 1, "user_message", { content: [{ type: "text", text: secret }] });
    lines.length = 0;
    expect(await check.leaked(c, { k: secret, m: "never-present-value" })).toEqual(["k"]);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("never-present-value");
  });

  it("measures 5,000 events with two values (no assertion)", async () => {
    const c = await conv();
    await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload)
      SELECT ${c}, g, 'tool_result',
        jsonb_build_object('type', 'tool_result', 'output', repeat('lorem ipsum ', 80) || g)
      FROM generate_series(1, 5000) g`.execute(raw);
    const t0 = performance.now();
    await check.leaked(c, { a: "not-in-the-log-1", b: "not-in-the-log-2" });
    console.log(`leak-check 5000 events, 2 values: ${(performance.now() - t0).toFixed(1)} ms`);
  });
});
