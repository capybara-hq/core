import { randomUUID } from "node:crypto";
import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectFileText } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { DeviceProjectFilesService } from "../../src/devices/device-project-files.service.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { SkillInvoker } from "../../src/skills/invoke.js";
import { CONNECTOR_TOOLS_QUEUE } from "../../src/tools/connector-tools-jobs.js";
import {
  ConnectorsService,
  type CreateConnectorInput,
} from "../../src/tools/connectors.service.js";
import { Credentials } from "../../src/tools/credentials.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableConnectorExtensions,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Inline tokens on send (composer inline tokens spec §3): `tokens` marked in `text` with U+FFFC
 * are resolved as the sender outside the message's transaction and logged as English
 * placeholders in `content[0]`, blocks after it (resources, project files, conversations,
 * connector mentions, then each file's `[file: …]` line and media block), `payload.inline` and
 * `payload.connectorMentions`; a refusal writes nothing. Connectors run on `fake-connector`
 * against fake MCP servers; no worker runs, so the sends' runs stay queued.
 */

const FAKE_CONNECTOR = fakeExtensionEntry("fake-connector");
const TOKEN = "tok_inline_tokens_value_0123456789";
const M = "￼";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
/** Tools `search` and `write` with resources (4 tools with list / read_resource). */
let docs: FakeMcpServer;
/** Tools `search` and `write`, no resources. */
let chat: FakeMcpServer;
/** 21 tools, no resources. */
let big: FakeMcpServer;
let req: Req;
let orgId: string;
let ownerId: string;
let agentId: string;

const TWO_TOOLS = [
  { name: "search", description: "Search", inputSchema: { type: "object" } },
  { name: "write", description: "Write", inputSchema: { type: "object" } },
];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const bearer = (t: string) => t === TOKEN;
  [docs, chat, big] = await Promise.all([
    startFakeMcpServer({
      verifyBearer: bearer,
      tools: TWO_TOOLS,
      resources: [
        { uri: "doc://send", name: "Send Message", text: "how to send" },
        { uri: "doc://other", name: "Send Message", text: "another one" },
        {
          uri: "doc://card",
          name: "Card",
          mimeType: "text/html; profile=mcp-app",
          text: "<html></html>",
        },
        { uri: "ui://widget", name: "Widget", text: "<div></div>" },
        { uri: "doc://empty", name: "Empty", text: "  \n " },
      ],
    }),
    startFakeMcpServer({ verifyBearer: bearer, tools: TWO_TOOLS }),
    startFakeMcpServer({
      verifyBearer: bearer,
      tools: Array.from({ length: 21 }, (_, i) => ({
        name: `t${String(i).padStart(2, "0")}`,
        description: `Tool ${i}`,
        inputSchema: { type: "object" },
      })),
    }),
  ]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [MODEL_FAKE, FAKE_CONNECTOR],
        extensionConfig: { "fake-connector": {} },
        // any tool count is over the threshold: the org setting alone switches tool search
        tools: { searchThresholdTools: 1 },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === CONNECTOR_TOOLS_QUEUE,
        },
      ],
    },
  );
});

afterAll(async () => {
  await k?.close();
  await Promise.all([docs?.stop(), chat?.stop(), big?.stop()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  const db = k.app.get(KernelDb);
  await truncateTables(db.pool, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (
    await accountsFor(db.pool).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  await enableConnectorExtensions(k, orgId);
  agentId = await createAgent(req, orgId);
  await toolSearch("off");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const db = () => k.app.get(KernelDb);

async function toolSearch(mode: "on" | "off") {
  await sql`UPDATE capybara.orgs SET settings = settings || ${JSON.stringify({ toolSearch: mode })}::jsonb WHERE id = ${orgId}`.execute(
    db().db,
  );
}

const input = (
  server: FakeMcpServer,
  over: Partial<CreateConnectorInput>,
): CreateConnectorInput => ({
  name: "Docs",
  slug: "docs",
  connector: "fake",
  endpoint: { url: server.url },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: TOKEN },
  ...over,
});

/** Creates a connector on `server` and lists its tools now (as `accountId` for a personal one). */
async function connector(
  server: FakeMcpServer,
  over: Partial<CreateConnectorInput> = {},
  accountId?: string,
): Promise<string> {
  const service = k.app.get(ConnectorsService);
  const id = await service.createDeferredIn(orgId, null, input(server, over));
  if (accountId !== undefined) {
    await k.app
      .get(Credentials)
      .setOAuthTokens(
        orgId,
        id,
        { kind: "user", accountId },
        { access_token: TOKEN, expires_at: Date.now() + 3_600_000, token_type: "Bearer" },
      );
  }
  const ready = accountId !== undefined || over.credential !== undefined || !("credential" in over);
  if (ready) {
    const r = await service.listToolsForJob({
      orgId,
      connectorId: id,
      ...(accountId !== undefined && { accountId }),
    });
    expect(r).toBe("listed");
  }
  return id;
}

/** A file row of the owner on a blob row of its own (no bytes: attaching reads only rows). */
async function file(name: string, contentType: string, status: "draft" | "ready" = "ready") {
  const id = randomUUID();
  const blobId = randomUUID();
  await db()
    .insertInto("blobs")
    .values({
      id: blobId,
      org_id: orgId,
      sha256: null,
      size: 7,
      etag: null,
      object_key: `blobs/${blobId}`,
      status: "ready",
    })
    .execute();
  await db()
    .insertInto("files")
    .values({
      id,
      org_id: orgId,
      account_id: ownerId,
      blob_id: blobId,
      ref_key: `blobs/${blobId}`,
      name,
      content_type: contentType,
      size: 7,
      origin: "upload",
      status,
      upload_purpose: status === "draft" ? "composer" : "library",
      expires_at: status === "draft" ? sql<Date>`now() + interval '24 hours'` : null,
    })
    .execute();
  return id;
}

const send = (conv: string, payload: Record<string, unknown>, r = req) =>
  r({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`, payload });

const errOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string; message?: string; details?: unknown[] } }).error;

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string) =>
  (await eventsOf(db().db, conv)).filter((e): e is UserMessage => e.type === "user_message");

const texts = (m: UserMessage | undefined) =>
  (m?.payload.content ?? []).map((b) => (b.type === "text" ? b.text : `<${b.type}>`));

/** A second conversation of the owner with one exchange, titled `title`. */
async function referenced(title: string | null) {
  const id = await createConv(req, orgId, agentId);
  await db().updateTable("conversations").set({ title }).where("id", "=", id).execute();
  await db()
    .insertInto("conversation_events")
    .values({
      conversation_id: id,
      seq: 1,
      type: "user_message",
      payload: JSON.stringify({
        content: [{ type: "text", text: "what about the EU plan?" }],
        authorAccountId: ownerId,
      }),
    })
    .execute();
  await db().updateTable("conversations").set({ last_seq: 1 }).where("id", "=", id).execute();
  return id;
}

/** Binds `conv` to a device project at /home/u/p whose files all exist. */
async function bindProject(conv: string) {
  const deviceId = randomUUID();
  await db()
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: ownerId,
      name: "Box",
      provider: "device-fake",
    })
    .execute();
  // the binding is fixed at creation (no update path in the schema types): written directly
  await sql`UPDATE capybara.conversations SET device_id = ${deviceId}, project_name = 'app',
    project_path = '/home/u/p' WHERE id = ${conv}`.execute(db().db);
  vi.spyOn(k.app.get(DeviceProjectFilesService), "statAll").mockResolvedValue({ missing: [] });
}

describe("tokens on the message body", () => {
  it("marker count mismatch is 400", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    for (const tokens of [
      [],
      [
        { type: "connector", connectorId: c },
        { type: "connector", connectorId: c },
      ],
    ]) {
      const res = await send(conv, { text: `a ${M}`, tokens });
      expect(res.statusCode, res.body).toBe(400);
      expect(errOf(res)?.code).toBe("validation_failed");
      expect(JSON.stringify(errOf(res)?.details)).toContain(
        "Each token needs one U+FFFC marker in text, in order",
      );
    }
    // a marker without any tokens field fails the count too
    expect((await send(conv, { text: `a ${M}` })).statusCode).toBe(400);
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("per-kind limits, the token cap, and the removed reference fields refused", async () => {
    const conv = await createConv(req, orgId, agentId);
    const four = Array.from({ length: 4 }, () => ({
      type: "connector",
      connectorId: randomUUID(),
    }));
    expect((await send(conv, { text: M.repeat(4), tokens: four })).statusCode).toBe(400);
    const many = Array.from({ length: 21 }, () => ({ type: "file", id: randomUUID() }));
    expect((await send(conv, { text: M.repeat(21), tokens: many })).statusCode).toBe(400);
    // attachments, projectFiles and conversationRefs left the body: each is an unknown key
    for (const old of [
      { attachments: [{ connectorId: randomUUID(), uri: "doc://1" }] },
      { projectFiles: [{ path: "a.ts" }] },
      { conversationRefs: [{ id: "y" }] },
    ]) {
      const res = await send(conv, { text: "hi", ...old });
      expect(res.statusCode, res.body).toBe(400);
      expect(errOf(res)?.code).toBe("validation_failed");
    }
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("per-kind caps count distinct entities", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = randomUUID();
    const over = [
      Array.from({ length: 6 }, (_, i) => ({
        type: "resource",
        connectorId: c,
        uri: `doc://${i}`,
      })),
      Array.from({ length: 11 }, (_, i) => ({ type: "projectFile", path: `f${i}.ts` })),
      Array.from({ length: 4 }, () => ({ type: "conversation", id: randomUUID() })),
    ];
    for (const tokens of over) {
      const res = await send(conv, { text: M.repeat(tokens.length), tokens });
      expect(res.statusCode, res.body).toBe(400);
      expect(errOf(res)?.code).toBe("validation_failed");
    }
    // eleven project file tokens naming five files (paths repeated, also unnormalized) pass the cap
    // of ten; under the cap of three, one conversation four times passes too
    const paths = [
      "a.ts",
      "./a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ];
    const sameFiles = [
      ...paths.map((path) => ({ type: "projectFile", path })),
      { type: "projectFile", path: "a.ts" },
    ];
    const r1 = await send(conv, { text: M.repeat(sameFiles.length), tokens: sameFiles });
    expect(errOf(r1)?.code).not.toBe("validation_failed");
    const id = randomUUID();
    const sameConv = Array.from({ length: 4 }, () => ({ type: "conversation", id }));
    const r2 = await send(conv, { text: M.repeat(4), tokens: sameConv });
    expect(errOf(r2)?.code).toBe("conversation.reference_unavailable");
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("same entity twice counts once: one block, a placeholder at each place", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const t = { type: "connector", connectorId: c };
    const res = await send(conv, { text: `${M}${M}${M}${M} hi`, tokens: [t, t, t, t] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)[0]).toBe(
      "[connector: Slack][connector: Slack][connector: Slack][connector: Slack] hi",
    );
    expect(m?.payload.content).toHaveLength(2);
    expect(m?.payload.connectorMentions).toHaveLength(1);
    expect(m?.payload.inline).toHaveLength(4);
  });
});

describe("connector mentions", () => {
  it("connector token renders placeholder and mention block", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const res = await send(conv, {
      text: `${M} 给小明发消息`,
      tokens: [{ type: "connector", connectorId: c }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.content).toEqual([
      { type: "text", text: "[connector: Slack] 给小明发消息" },
      {
        type: "text",
        text: '[connector: Slack] The person named the connector "Slack" for this message. Its tools are named mcp__slack__<tool>.',
      },
    ]);
    expect(m?.payload.connectorMentions).toEqual([
      // tool search off at send time: the second sentence is left out, the keys are recorded
      // (inert in a step without tool search)
      {
        connectorId: c,
        slug: "slack",
        name: "Slack",
        toolCount: 2,
        loadedTools: ["mcp__slack__search", "mcp__slack__write"],
      },
    ]);
    expect(m?.payload.inline).toEqual([
      { kind: "connector", start: 0, end: 18, label: "Slack", ref: { connectorId: c } },
    ]);
  });

  it("mention under tool search with 20 or fewer tools loads them", async () => {
    await toolSearch("on");
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const res = await send(conv, {
      text: `ask ${M}`,
      tokens: [{ type: "connector", connectorId: c }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)[1]).toMatch(/ Its 2 tools are loaded from this message on\.$/);
    expect([...(m?.payload.connectorMentions?.[0]?.loadedTools ?? [])].sort()).toEqual([
      "mcp__slack__search",
      "mcp__slack__write",
    ]);
  });

  it("more than 20 tools loads none", async () => {
    await toolSearch("on");
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(big, { name: "Big", slug: "big" });
    const res = await send(conv, { text: M, tokens: [{ type: "connector", connectorId: c }] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)[1]).toBe(
      '[connector: Big] The person named the connector "Big" for this message. Its tools are named mcp__big__<tool>. It has 21 tools; load the ones this message needs with ToolSearch.',
    );
    expect(m?.payload.connectorMentions?.[0]).toMatchObject({ toolCount: 21, loadedTools: [] });
  });

  it("connector refused: not_found / needs_config / not_offered", async () => {
    const pending = await connector(chat, {
      name: "Pending",
      slug: "pending",
      credential: undefined,
    });
    const off = await connector(chat, { name: "Off", slug: "off" });
    const disabled = await connector(chat, { name: "Disabled", slug: "disabled" });
    await k.app.get(ConnectorsService).update(orgId, disabled, ownerId, { status: "disabled" });
    const noTools = await connector(chat, { name: "Quiet", slug: "quiet" });
    await db()
      .updateTable("connector_tools")
      .set({ status: "disabled" })
      .where("connector_id", "=", noTools)
      .execute();
    const a = await (async () => {
      const r = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Picky",
            model: { provider: "model-fake", model: "fake-1" },
            disabledTools: [{ kind: "connector", connectorId: off, tools: "all" }],
          },
          visibility: "org",
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json() as { agent: { id: string } }).agent.id;
    })();
    const conv = await createConv(req, orgId, a);
    const missing = randomUUID();
    const ids = [missing, pending, off, disabled, noTools];
    const res = await send(conv, {
      text: `${M}${M}${M}`,
      tokens: ids.slice(0, 3).map((connectorId) => ({ type: "connector", connectorId })),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)?.code).toBe("conversation.connector_unavailable");
    expect(errOf(res)?.details).toEqual([
      { connectorId: missing, reason: "not_found" },
      { connectorId: pending, reason: "needs_config" },
      { connectorId: off, reason: "not_offered" },
    ]);
    const res2 = await send(conv, {
      text: `${M}${M}`,
      tokens: [disabled, noTools].map((connectorId) => ({ type: "connector", connectorId })),
    });
    expect(res2.statusCode, res2.body).toBe(422);
    expect(errOf(res2)?.details).toEqual([
      { connectorId: disabled, reason: "not_found" },
      { connectorId: noTools, reason: "not_offered" },
    ]);
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("personal credential missing is accepted", async () => {
    const c = await connector(
      chat,
      {
        name: "Mine",
        slug: "mine",
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
        credential: undefined,
      },
      ownerId,
    );
    const login = `m-${randomUUID().slice(0, 8)}`;
    const bob = (
      await accountsFor(db().pool).createLocal({ login, password: PW, displayName: login })
    ).id;
    await testMembers(db().pool).add(orgId, bob, "member", ownerId);
    const bobReq = await session(k, login);
    const conv = await createConv(bobReq, orgId, agentId);
    const res = await send(
      conv,
      { text: M, tokens: [{ type: "connector", connectorId: c }] },
      bobReq,
    );
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(m?.payload.connectorMentions?.[0]).toMatchObject({ connectorId: c, toolCount: 2 });
  });

  it("connector refused after deletion writes nothing", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    await k.app.get(ConnectorsService).remove(orgId, c, ownerId);
    const before = (await eventsOf(db().db, conv)).length;
    const res = await send(conv, {
      text: `${M} hi`,
      tokens: [{ type: "connector", connectorId: c }],
      clientMessageId: "del-1",
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)?.details).toEqual([{ connectorId: c, reason: "not_found" }]);
    expect(await eventsOf(db().db, conv)).toHaveLength(before);
  });
});

describe("resource tokens", () => {
  it("resource block head carries the placeholder and the connector", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    const res = await send(conv, {
      text: `read ${M}`,
      tokens: [{ type: "resource", connectorId: c, uri: "doc://send" }],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)).toEqual([
      "read [resource: Send Message from Slack]",
      '[resource: Send Message from Slack] Attached resource "Send Message" (doc://send) from the connector Slack:\n\nhow to send',
    ]);
    expect(m?.payload.attachments).toEqual([
      { appId: c, appName: "Slack", uri: "doc://send", name: "Send Message" },
    ]);
    expect(m?.payload.inline?.[0]).toEqual({
      kind: "resource",
      start: 5,
      end: 5 + "[resource: Send Message from Slack]".length,
      label: "Send Message",
      ref: { connectorId: c, uri: "doc://send" },
    });
  });

  it("two resources with one name are numbered in text order", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    const res = await send(conv, {
      text: `${M} ${M}`,
      tokens: [
        { type: "resource", connectorId: c, uri: "doc://other" },
        { type: "resource", connectorId: c, uri: "doc://send" },
      ],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)[0]).toBe(
      "[resource: Send Message from Slack] [resource: Send Message (2) from Slack]",
    );
    expect(texts(m)[2]).toMatch(/^\[resource: Send Message \(2\) from Slack\] Attached resource/);
  });

  it("resource ui_template and empty refused", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    for (const [uri, reason] of [
      ["doc://card", "ui_template"],
      ["ui://widget", "ui_template"],
      ["doc://empty", "empty"],
    ] as const) {
      const res = await send(conv, {
        text: M,
        tokens: [{ type: "resource", connectorId: c, uri }],
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(errOf(res)?.code).toBe("connector.resource_unreadable");
      expect(errOf(res)?.details).toEqual([{ connectorId: c, uri, reason }]);
    }
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("resource refused when the agent does not offer read_resource", async () => {
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    const r = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "NoRead",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: [{ kind: "connector", connectorId: c, tools: ["read_resource"] }],
        },
        visibility: "org",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const conv = await createConv(req, orgId, (r.json() as { agent: { id: string } }).agent.id);
    const res = await send(conv, {
      text: M,
      tokens: [{ type: "resource", connectorId: c, uri: "doc://send" }],
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(errOf(res)?.code).toBe("connector.resources_disabled");
    expect(await userMessages(conv)).toHaveLength(0);
  });
});

describe("file lines", () => {
  it("file token and uploads get file lines with shared numbering", async () => {
    const conv = await createConv(req, orgId, agentId);
    const lib = await file("a.png", "image/png");
    const up = await file("a.png", "image/png", "draft");
    const res = await send(conv, {
      text: `see ${M}`,
      tokens: [{ type: "file", id: lib }],
      files: [up],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)).toEqual([
      "see [file: a.png]",
      "[file: a.png]",
      "<image>",
      "[file: a.png (2)]",
      "<image>",
    ]);
    const refs = (m?.payload.content ?? []).flatMap((b) =>
      b.type === "image" && b.source.kind === "ref" ? [b.source.fileId] : [],
    );
    expect(refs).toEqual([lib, up]);
  });

  it("a file both a token and an upload is attached once, as the token", async () => {
    const conv = await createConv(req, orgId, agentId);
    const f = await file("a.png", "image/png", "draft");
    const res = await send(conv, {
      text: `see ${M}`,
      tokens: [{ type: "file", id: f }],
      files: [f],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)).toEqual(["see [file: a.png]", "[file: a.png]", "<image>"]);
  });

  it("file tokens and uploads over the per-message cap are refused before any remote read", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    const ups = [await file("u.png", "image/png", "draft")];
    const tokens = [
      ...Array.from({ length: 10 }, () => ({ type: "file", id: randomUUID() })),
      { type: "resource", connectorId: c, uri: "doc://send" },
    ];
    const before = docs.requests.length;
    const res = await send(conv, { text: M.repeat(tokens.length), tokens, files: ups });
    expect(res.statusCode, res.body).toBe(400);
    expect(errOf(res)).toMatchObject({
      code: "validation_failed",
      details: [{ path: "files", message: "At most 10 files per message" }],
    });
    expect(docs.requests.length).toBe(before);
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("upload-only message starts with a file line", async () => {
    const conv = await createConv(req, orgId, agentId);
    const up = await file("b.pdf", "application/pdf", "draft");
    const res = await send(conv, { text: "", files: [up] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)).toEqual(["[file: b.pdf]", "<document>"]);
  });

  it("uploads without tokens get file lines too", async () => {
    const conv = await createConv(req, orgId, agentId);
    const a = await file("x.png", "image/png", "draft");
    const b = await file("x.png", "image/png", "draft");
    const res = await send(conv, { text: "two", files: [a, b] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)).toEqual(["two", "[file: x.png]", "<image>", "[file: x.png (2)]", "<image>"]);
  });
});

describe("order, offsets, skills, retries", () => {
  it("block order and inline offsets point at placeholders", async () => {
    const conv = await createConv(req, orgId, agentId);
    await bindProject(conv);
    const slack = await connector(chat, { name: "Slack", slug: "slack" });
    const wiki = await connector(docs, { name: "Wiki", slug: "wiki" });
    const other = await referenced(null);
    const lib = await file("plan.pdf", "application/pdf");
    const up = await file("shot.png", "image/png", "draft");
    const res = await send(conv, {
      text: `${M} and ${M}, ${M}, ${M}, ${M}`,
      tokens: [
        { type: "file", id: lib },
        { type: "connector", connectorId: slack },
        { type: "conversation", id: other },
        { type: "projectFile", path: "./src/app.ts" },
        { type: "resource", connectorId: wiki, uri: "doc://send" },
      ],
      files: [up],
    });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    const t = texts(m);
    expect(t[0]).toBe(
      "[file: plan.pdf] and [connector: Slack], [conversation: Untitled conversation], [project file: src/app.ts], [resource: Send Message from Wiki]",
    );
    expect(t[1]).toMatch(/^\[resource: Send Message from Wiki\] Attached resource "Send Message"/);
    expect(t[2]).toBe(`[project file: src/app.ts] ${projectFileText("src/app.ts", "/home/u/p")}`);
    expect(t[3]?.split("\n")[0]).toBe("[conversation: Untitled conversation]");
    expect(t[3]).toContain(other);
    expect(t[4]).toMatch(/^\[connector: Slack\] The person named the connector "Slack"/);
    expect(t.slice(5)).toEqual(["[file: plan.pdf]", "<document>", "[file: shot.png]", "<image>"]);
    expect(m?.payload.projectFiles).toEqual([{ path: "src/app.ts" }]);
    expect(m?.payload.conversationRefs?.map((r) => r.id)).toEqual([other]);
    const inline = m?.payload.inline ?? [];
    expect(inline.map((e) => e.kind)).toEqual([
      "file",
      "connector",
      "conversation",
      "projectFile",
      "resource",
    ]);
    for (const e of inline) {
      expect(t[0]?.slice(e.start, e.end)).toMatch(/^\[[a-z ]+: .*\]$/);
      expect(t[0]?.slice(e.start, e.end)).toContain(e.label);
    }
    expect(inline[3]?.ref).toEqual({ path: "src/app.ts" });
    expect(inline[0]?.ref).toEqual({ fileId: lib });
  });

  it("a project file token leaving the project is refused before anything is read", async () => {
    const conv = await createConv(req, orgId, agentId);
    await bindProject(conv);
    const res = await send(conv, { text: M, tokens: [{ type: "projectFile", path: "../x" }] });
    expect(res.statusCode, res.body).toBe(422);
    expect(errOf(res)?.code).toBe("device.path_outside_project");
    expect(await userMessages(conv)).toHaveLength(0);
  });

  it("skill arguments carry placeholders and inline offsets", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const prepare = vi.spyOn(k.app.get(SkillInvoker), "prepare").mockImplementation(async (a) => ({
      text: `RENDERED ${a.args}`,
      skill: {
        id: randomUUID(),
        version: 1,
        source: "org",
        name: "notify",
        arguments: a.args.trim(),
        mode: "inline",
      },
    }));
    const res = await send(conv, {
      text: `  tell ${M} now `,
      skill: { name: "notify" },
      tokens: [{ type: "connector", connectorId: c }],
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(prepare.mock.calls[0]?.[0].args).toBe("tell [connector: Slack] now");
    const [m] = await userMessages(conv);
    const args = m?.payload.skill?.arguments ?? "";
    expect(args).toBe("tell [connector: Slack] now");
    const [e] = m?.payload.inline ?? [];
    expect(args.slice(e?.start, e?.end)).toBe("[connector: Slack]");
    expect(texts(m)[0]).toBe("RENDERED tell [connector: Slack] now");
  });

  it("retry with the same clientMessageId reads nothing", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(docs, { name: "Slack", slug: "slack" });
    const body = {
      text: `${M} ${M}`,
      clientMessageId: "retry-1",
      tokens: [
        { type: "connector", connectorId: c },
        { type: "resource", connectorId: c, uri: "doc://send" },
      ],
    };
    const first = await send(conv, body);
    expect(first.statusCode, first.body).toBe(202);
    const forAgent = vi.spyOn(k.app.get(ToolRegistry), "forAgent");
    const before = docs.requests.length;
    const again = await send(conv, body);
    expect(again.statusCode, again.body).toBe(202);
    expect((again.json() as { event: { seq: number } }).event.seq).toBe(
      (first.json() as { event: { seq: number } }).event.seq,
    );
    expect(docs.requests.length).toBe(before);
    expect(forAgent).not.toHaveBeenCalled();
    expect(await userMessages(conv)).toHaveLength(1);
  });

  it("on create with realistic thresholds: no tool search sentence, the keys still recorded", async () => {
    await toolSearch("on");
    const config = k.app.get(KernelConfigService);
    const real = config.get();
    vi.spyOn(config, "get").mockReturnValue({
      ...real,
      tools: { ...real.tools, searchThresholdTools: 30, searchThresholdTokens: 8000 },
    });
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        message: {
          text: `${M} hi`,
          clientMessageId: "real-1",
          tokens: [{ type: "connector", connectorId: c }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { conversation: { id: string } }).conversation.id;
    const [m] = await userMessages(id);
    expect(texts(m)[1]).toBe(
      '[connector: Slack] The person named the connector "Slack" for this message. Its tools are named mcp__slack__<tool>.',
    );
    expect([...(m?.payload.connectorMentions?.[0]?.loadedTools ?? [])].sort()).toEqual([
      "mcp__slack__search",
      "mcp__slack__write",
    ]);
  });

  it("the mention text folds the connector name", async () => {
    const conv = await createConv(req, orgId, agentId);
    const c = await connector(chat, { name: "Team [ops]\nchat", slug: "team" });
    const res = await send(conv, { text: M, tokens: [{ type: "connector", connectorId: c }] });
    expect(res.statusCode, res.body).toBe(202);
    const [m] = await userMessages(conv);
    expect(texts(m)[1]).toMatch(
      /^\[connector: Team \(ops\) chat\] The person named the connector "Team \(ops\) chat" for/,
    );
    expect(m?.payload.connectorMentions?.[0]?.name).toBe("Team [ops]\nchat");
  });

  it("create and first-message forward tokens", async () => {
    const c = await connector(chat, { name: "Slack", slug: "slack" });
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: {
        agentId,
        message: {
          text: `${M} hi`,
          clientMessageId: "c-1",
          tokens: [{ type: "connector", connectorId: c }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { conversation: { id: string } }).conversation.id;
    expect(texts((await userMessages(id))[0])[0]).toBe("[connector: Slack] hi");
    const first = (clientMessageId: string, connectorId: string) =>
      req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/first-message`,
        payload: {
          agentId,
          permission: { profile: "request-approval" },
          message: {
            text: `${M} hi`,
            clientMessageId,
            tokens: [{ type: "connector", connectorId }],
          },
        },
      });
    const home = await first("c-2", c);
    expect(home.statusCode, home.body).toBe(201);
    const homeId = (home.json() as { conversation: { id: string } }).conversation.id;
    expect(texts((await userMessages(homeId))[0])[0]).toBe("[connector: Slack] hi");
    // a refusal creates nothing
    const refused = await first("c-3", randomUUID());
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errOf(refused)?.code).toBe("conversation.connector_unavailable");
    const none = await db()
      .selectFrom("conversations")
      .select("id")
      .where("create_request_id", "=", "c-3")
      .execute();
    expect(none).toEqual([]);
  });
});
