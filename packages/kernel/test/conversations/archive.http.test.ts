import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
} from "../helpers/runs.js";

/** Web order Task 1: a person archives (hidden from the default lists) or deletes (soft) a chat. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }));
}, 120_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
});

const base = () => `/api/v1/orgs/${orgId}/conversations`;
const patch = (id: string, payload: Record<string, unknown>) =>
  owner({ method: "PATCH", url: `${base()}/${id}`, payload });
const ids = async (url: string) =>
  (
    (await owner({ method: "GET", url })).json() as { conversations: { id: string }[] }
  ).conversations.map((c) => c.id);
const groupIds = async () =>
  (
    (await owner({ method: "GET", url: `${base()}/groups` })).json() as {
      groups: { conversations: { id: string }[] }[];
    }
  ).groups.flatMap((g) => g.conversations.map((c) => c.id));

describe("archive and soft delete", { timeout: 60_000 }, () => {
  it("archive hides from list and groups; unarchive brings it back", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await patch(conv, { archived: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (r.json() as { conversation: { archivedAt: string | null } }).conversation.archivedAt,
    ).not.toBeNull();
    expect(await ids(base())).not.toContain(conv);
    expect(await groupIds()).not.toContain(conv);
    expect((await owner({ method: "GET", url: `${base()}/${conv}` })).statusCode).toBe(200);

    const back = await patch(conv, { archived: false });
    expect(back.statusCode, back.body).toBe(200);
    expect(
      (back.json() as { conversation: { archivedAt: string | null } }).conversation.archivedAt,
    ).toBeNull();
    expect(await ids(base())).toContain(conv);
    expect(await groupIds()).toContain(conv);
  });

  it("a message unarchives", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await patch(conv, { archived: true })).statusCode).toBe(200);
    await postMessage(owner, orgId, conv, "echo:hi");
    const got = await owner({ method: "GET", url: `${base()}/${conv}` });
    expect(
      (got.json() as { conversation: { archivedAt: string | null } }).conversation.archivedAt,
    ).toBeNull();
  });

  it("PATCH with neither field is 400", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await patch(conv, {});
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
  });

  it("delete hides everywhere for the owner", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await owner({ method: "DELETE", url: `${base()}/${conv}` });
    expect(r.statusCode, r.body).toBe(204);
    expect((await owner({ method: "GET", url: `${base()}/${conv}` })).statusCode).toBe(404);
    expect((await owner({ method: "GET", url: `${base()}/${conv}/events` })).statusCode).toBe(404);
    expect(await ids(base())).not.toContain(conv);
    expect(await groupIds()).not.toContain(conv);
    const again = await owner({ method: "DELETE", url: `${base()}/${conv}` });
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: { code: string } }).error.code).toBe("conversation.not_found");
  });

  it("delete stops a waiting run and clears its pending question", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Asker",
          instructions: "Ask.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    const askerId = (res.json() as { agent: { id: string } }).agent.id;
    const conv = await createConv(owner, orgId, askerId);
    const ask = `tool:ask_user:${JSON.stringify({
      questions: [
        {
          question: "Which?",
          header: "Pick",
          multiSelect: false,
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    })}`;
    await postMessage(owner, orgId, conv, ask);
    const asked = (await waitForEvent(
      db,
      conv,
      (e) => e.type === "question_asked",
      10_000,
      "question_asked",
    )) as Extract<ConversationEvent, { type: "question_asked" }>;
    await waitFor(
      async () => (await runsOf(db, conv)).some((r) => r.status === "waiting"),
      10_000,
      "run waiting",
    );
    const r = await owner({ method: "DELETE", url: `${base()}/${conv}` });
    expect(r.statusCode, r.body).toBe(204);
    await waitFor(
      async () => (await runsOf(db, conv)).every((x) => x.status === "aborted"),
      10_000,
      "run aborted",
    );
    const inbox = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(inbox.body).not.toContain(asked.payload.questionId);
    const q = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/questions/${asked.payload.questionId}`,
    });
    expect(q.statusCode, q.body).toBe(200);
    expect((q.json() as { question: { status: string } }).question.status).not.toBe("pending");
  });

  it("delete keeps the trajectory for the org owner (trajectory viewers)", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:hi");
    await waitFor(
      async () => (await runsOf(db, conv)).some((r) => r.status === "completed"),
      15_000,
      "completed",
    );
    expect((await owner({ method: "DELETE", url: `${base()}/${conv}` })).statusCode).toBe(204);
    const t = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${conv}` });
    expect(t.statusCode, t.body).toBe(200);
  });

  it("delete unbinds channel threads", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const connId = randomUUID();
    await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
      VALUES (${connId}, ${orgId}, 'fake-im', 'bot', ${agentId}, ${ownerId})`.execute(raw);
    await sql`INSERT INTO capybara.channel_threads
        (id, connection_id, chat_id, thread_key, account_id, conversation_id)
      VALUES (${randomUUID()}, ${connId}, 'chat-1', 't1', ${ownerId}, ${conv})`.execute(raw);
    expect((await owner({ method: "DELETE", url: `${base()}/${conv}` })).statusCode).toBe(204);
    const rows =
      await sql`SELECT 1 FROM capybara.channel_threads WHERE conversation_id = ${conv}`.execute(
        raw,
      );
    expect(rows.rows).toHaveLength(0);
  });

  it("deleting a sub-agent conversation is conversation.read_only", async () => {
    const parent = await createConv(owner, orgId, agentId);
    const child = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_type)
      VALUES (${child}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${parent}, 'general')`.execute(
      raw,
    );
    const r = await owner({ method: "DELETE", url: `${base()}/${child}` });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe("conversation.read_only");
  });

  it("a rejected message leaves the conversation archived", async () => {
    const conv = await createConv(owner, orgId, agentId);
    expect((await patch(conv, { archived: true })).statusCode).toBe(200);
    const r = await owner({
      method: "POST",
      url: `${base()}/${conv}/messages`,
      payload: { text: "x", skill: { name: "no-such-skill" } },
    });
    expect(r.statusCode, r.body).toBe(400);
    const got = await owner({ method: "GET", url: `${base()}/${conv}` });
    expect(
      (got.json() as { conversation: { archivedAt: string | null } }).conversation.archivedAt,
    ).not.toBeNull();
  });

  it("a deleted parent hides its sub-agent conversations", async () => {
    const parent = await createConv(owner, orgId, agentId);
    const child = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id, subagent_type)
      VALUES (${child}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${parent}, 'general')`.execute(
      raw,
    );
    expect((await owner({ method: "GET", url: `${base()}/${child}` })).statusCode).toBe(200);
    expect((await owner({ method: "DELETE", url: `${base()}/${parent}` })).statusCode).toBe(204);
    expect((await owner({ method: "GET", url: `${base()}/${child}` })).statusCode).toBe(404);
    expect((await owner({ method: "GET", url: `${base()}/${child}/events` })).statusCode).toBe(404);
  });

  it("queued messages start no run after a delete", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `slow:60:${"x".repeat(60)}`);
    await waitFor(
      async () => (await runsOf(db, conv)).some((r) => r.status === "running"),
      15_000,
      "running",
    );
    const q = await owner({
      method: "POST",
      url: `${base()}/${conv}/queue`,
      payload: { text: "echo:later", clientMessageId: randomUUID() },
    });
    expect(q.statusCode, q.body).toBe(201);
    expect((await owner({ method: "DELETE", url: `${base()}/${conv}` })).statusCode).toBe(204);
    await waitFor(
      async () => (await runsOf(db, conv)).every((r) => r.status === "aborted"),
      15_000,
      "aborted",
    );
    await new Promise((r) => setTimeout(r, 2000));
    expect(await runsOf(db, conv)).toHaveLength(1);
    const left =
      await sql`SELECT 1 FROM capybara.conversation_queue WHERE conversation_id = ${conv}`.execute(
        raw,
      );
    expect(left.rows).toHaveLength(0);
  });
});
