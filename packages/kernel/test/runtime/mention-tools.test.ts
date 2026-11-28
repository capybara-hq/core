import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { CONNECTOR_TOOLS_QUEUE } from "../../src/tools/connector-tools-jobs.js";
import { ConnectorsService } from "../../src/tools/connectors.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableConnectorExtensions,
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
 * Connector mentions load their tools (composer inline tokens spec §3.5): under tool search, a
 * message naming a connector with at most 20 offered tools records their keys in
 * `connectorMentions[].loadedTools`, and request building adds them to the loaded set from that
 * message on, beside what `ToolSearch` loaded. Real kernel with a worker, model-fake, and
 * fake-connector against a fake MCP server; requests captured at the provider.
 */

const FAKE_CONNECTOR = fakeExtensionEntry("fake-connector");
const TOKEN = "tok_mention_tools_value_0123456789";
const M = "￼";
const SLACK_KEYS = ["mcp__slack__search", "mcp__slack__write"];

const capture = captureProviderRequests();
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
/** Tools `search` and `write`. */
let chat: FakeMcpServer;
/** 21 tools: over the mention load limit. */
let big: FakeMcpServer;
let req: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  [chat, big] = await Promise.all([
    startFakeMcpServer({
      verifyBearer: (t) => t === TOKEN,
      tools: [
        { name: "search", description: "Search", inputSchema: { type: "object" } },
        { name: "write", description: "Write", inputSchema: { type: "object" } },
      ],
    }),
    startFakeMcpServer({
      verifyBearer: (t) => t === TOKEN,
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
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, FAKE_CONNECTOR],
        extensionConfig: { "fake-connector": {} },
        // any tool count is over the threshold: the org setting alone switches tool search
        tools: { searchThresholdTools: 1 },
      },
    ),
    {
      // the tools are listed by the test itself, not by the background job
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
  capture.restore();
  await k?.close();
  await Promise.all([chat?.stop(), big?.stop()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const db = () => k.app.get(KernelDb);

beforeEach(async () => {
  capture.reset();
  await truncateTables(db().pool, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db().pool).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  await enableConnectorExtensions(k, orgId);
  await toolSearch("on");
  slack = await connector(chat, "Slack", "slack");
  agentId = await createAgent(req, orgId);
});

let slack: string;

async function toolSearch(mode: "on" | "off") {
  await sql`UPDATE capybara.orgs SET settings = settings || ${JSON.stringify({ toolSearch: mode })}::jsonb WHERE id = ${orgId}`.execute(
    db().db,
  );
}

/** An org connector on `server` with its tools listed now. */
async function connector(server: FakeMcpServer, name: string, slug: string): Promise<string> {
  const service = k.app.get(ConnectorsService);
  const connectorId = await service.createDeferredIn(orgId, null, {
    name,
    slug,
    connector: "fake",
    endpoint: { url: server.url },
    auth: { type: "bearer", ownership: "org" },
    credential: { token: TOKEN },
  });
  expect(await service.listToolsForJob({ orgId, connectorId })).toBe("listed");
  return connectorId;
}

async function sendMention(conv: string, connectorId = slack) {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
    payload: { text: `echo:ask ${M}`, tokens: [{ type: "connector", connectorId }] },
  });
  expect(res.statusCode, res.body).toBe(202);
}

// model-fake calls a lone tool by default: `echo:` messages keep each run to one request
const toolNames = (i: number) => (capture.sent[i]?.tools ?? []).map((t) => t.name);

describe("connector mentions load their tools", () => {
  it("next request carries mention-loaded tools", async () => {
    const conv = await createConv(req, orgId, agentId);
    await sendMention(conv);
    await waitForTerminal(db().db, conv, 1, 30_000);
    expect(capture.sent).toHaveLength(1);
    expect(toolNames(0)).toEqual(["ToolSearch", ...SLACK_KEYS]);
    // the connector's tools stay in the deferred catalog, the loaded ones get full definitions
    expect(capture.sent[0]?.system).toHaveLength(2);
  });

  it("mention-loaded tools stay loaded on later turns", async () => {
    const conv = await createConv(req, orgId, agentId);
    await sendMention(conv);
    await waitForTerminal(db().db, conv, 1, 30_000);
    await postMessage(req, orgId, conv, "echo:and then?");
    await waitForTerminal(db().db, conv, 2, 30_000);
    expect(capture.sent).toHaveLength(2);
    expect(toolNames(1)).toEqual(["ToolSearch", ...SLACK_KEYS]);
  });

  it("a conversation without a mention loads nothing", async () => {
    const conv = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, conv, "echo:hello");
    await waitForTerminal(db().db, conv, 1, 30_000);
    expect(toolNames(0)).toEqual(["ToolSearch"]);
  });

  it("a connector over 20 tools loads none: they stay in the catalog", async () => {
    const many = await connector(big, "Big", "big");
    const agent = await createAgent(req, orgId);
    const conv = await createConv(req, orgId, agent);
    await sendMention(conv, many);
    await waitForTerminal(db().db, conv, 1, 30_000);
    expect(toolNames(0)).toEqual(["ToolSearch"]);
    expect(capture.sent[0]?.system[1]?.text).toContain("- mcp__big__t20: Tool 20");
  });

  it("without tool search the recorded keys are inert: every tool is loaded as before", async () => {
    await toolSearch("off");
    const conv = await createConv(req, orgId, agentId);
    await sendMention(conv);
    await waitForTerminal(db().db, conv, 1, 30_000);
    expect(toolNames(0)).toEqual(SLACK_KEYS);
    expect(capture.sent[0]?.system).toHaveLength(1);
  });

  it("keys of a connector no longer offered are ignored", async () => {
    const conv = await createConv(req, orgId, agentId);
    await sendMention(conv);
    await waitForTerminal(db().db, conv, 1, 30_000);
    const owner = (await db().db.selectFrom("accounts").select("id").executeTakeFirstOrThrow()).id;
    await k.app.get(ConnectorsService).remove(orgId, slack, owner);
    await postMessage(req, orgId, conv, "echo:and then?");
    await waitForTerminal(db().db, conv, 2, 30_000);
    expect(toolNames(0)).toEqual(["ToolSearch", ...SLACK_KEYS]);
    expect(toolNames(1)).toEqual([]);
  });
});
