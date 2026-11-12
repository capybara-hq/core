import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Memory plugin spec §6.2: an extension tool limited by `spec.sources` is offered only in those
 * conversation sources (the source stored on the conversation row, read once per run), and a plugin
 * handler learns the source, the conversation's owner and the trigger account's role.
 * `fake-tools-ui`'s `web-only` (sources web and channel_dm) reports its call context.
 */

const KEY = "plugin__fake-tools-ui__web-only";
const CALL = `tool:${KEY}:{}`;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fakeExtensionEntry("fake-tools-ui")] },
    ),
  );
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let member: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  member = await session(k, "mem");
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/fake-tools-ui`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Prober",
        instructions: "Use tools.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const listed = (source?: ConversationSource) =>
  k.app.get(ToolRegistry).forAgent(orgId, source === undefined ? {} : { source });

/** The `tool_result` of the run's `web-only` call. */
async function callIn(conv: string, req: Req): Promise<{ content: string; isError: boolean }> {
  const seq = await postMessage(req, orgId, conv, CALL);
  await waitForTerminal(db, conv, seq, 20_000);
  const result = (await eventsOf(db, conv)).find(
    (e) => e.type === "tool_result" && e.payload.toolKey === KEY,
  );
  expect(result).toBeDefined();
  return result?.payload as { content: string; isError: boolean };
}

/** Sets a conversation's source (never changed in the product; the column takes no update). */
const setSource = (conv: string, source: ConversationSource) =>
  sql`UPDATE capybara.conversations SET source = ${source} WHERE id = ${conv}`.execute(raw);

describe("extension tools by conversation source", { timeout: 60_000 }, () => {
  it("forAgent hides a tool from the sources it leaves out, with the reason", async () => {
    for (const source of [undefined, "web", "channel_dm"] as const) {
      const r = await listed(source);
      expect(r.tools.map((t) => t.key)).toContain(KEY);
      expect(r.hidden?.some((h) => h.ref === KEY)).toBe(false);
    }
    for (const source of ["channel_group", "subagent"] as const) {
      const r = await listed(source);
      expect(r.tools.map((t) => t.key)).not.toContain(KEY);
      expect(r.hidden).toContainEqual({
        ref: KEY,
        reason: `Not available in ${source} conversations`,
      });
      // a tool without `sources` is offered everywhere
      expect(r.tools.map((t) => t.key)).toContain("plugin__fake-tools-ui__write");
    }
  });

  it("the handler gets the source, the owner, the trigger account and its role", async () => {
    const conv = await createConv(member, orgId, agentId);
    const r = await callIn(conv, member);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({
      source: "web",
      ownerAccountId: memberId,
      accountId: memberId,
      role: "member",
    });
  });

  it("the owner is the conversation's account, the caller the run's trigger account", async () => {
    // a conversation of the owner's whose run a member triggers (as in a group chat)
    const conv = await createConv(owner, orgId, agentId);
    await setSource(conv, "channel_dm");
    const svc = k.app.get(ConversationsService);
    const view = await svc.writable(orgId, conv, ownerId);
    const spy = vi.spyOn(svc, "writable").mockResolvedValueOnce(view);
    try {
      const r = await callIn(conv, member);
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content)).toEqual({
        source: "channel_dm",
        ownerAccountId: ownerId,
        accountId: memberId,
        role: "member",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a call in a source the tool leaves out is refused with the reason", async () => {
    for (const source of ["channel_group", "subagent"] as const) {
      const conv = await createConv(owner, orgId, agentId);
      await setSource(conv, source);
      const r = await callIn(conv, owner);
      expect(r.isError).toBe(true);
      expect(r.content).toContain(`Not available in ${source} conversations`);
    }
  });
});
