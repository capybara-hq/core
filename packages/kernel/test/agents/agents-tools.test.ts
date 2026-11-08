import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentDefinition, AgentDefinitionSchema } from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { runModelStep } from "../../src/runtime/model-call.js";
import { RunSteps } from "../../src/runtime/run-steps.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { enableConnectorExtensions, startKernel, type TestKernel } from "../helpers/runs.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const TOOLS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/tools-probe/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let req: ReturnType<typeof asUser>;
let orgId: string;
let ownerId: string;

const PW = "correct horse battery";
const MODEL = { provider: "model-fake", model: "fake-1" };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [...MODEL_PLUGINS_CONFIG.extensions, MEM_CONNECTOR, TOOLS_PROBE],
      extensionPermissions: { autoApprove: true },
      extensionConfig: MODEL_PLUGINS_CONFIG.extensionConfig,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  memState().servers = {
    open: {
      tools: [
        {
          name: "read",
          description: "Read a document.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "write", description: "Write a document.", inputSchema: { type: "object" } },
      ],
    },
  };
  req = asUser(k.http, cookieJar());
  const login = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrg("Acme");
});

async function createOrg(name: string): Promise<string> {
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(org.statusCode, org.body).toBe(201);
  const id = (org.json() as { org: { id: string } }).org.id;
  await enableConnectorExtensions(k, id);
  return id;
}

async function installConnector(slug: string, inOrg = orgId): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${inOrg}/connectors`,
    payload: {
      name: slug,
      slug,
      connector: "mem",
      endpoint: { server: "open" },
      auth: { type: "none" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

type AgentRes = { agent: { id: string; definition: AgentDefinition } };

const createAgent = (definition: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: { name: "Helper", model: MODEL, ...definition }, visibility: "org" },
  });

const detailPaths = (res: { json(): unknown }): string[] =>
  (res.json() as { error: { details?: { path: string }[] } }).error.details?.map((d) => d.path) ??
  [];

describe("agent definition tools (tools default-on spec §2)", () => {
  it("a definition without disabledTools or toolPolicies parses and reads as nothing turned off", async () => {
    const parsed = AgentDefinitionSchema.parse({ name: "Old", model: MODEL });
    expect(parsed.disabledTools).toEqual([]);
    expect(parsed.toolPolicies).toEqual({});

    const res = await createAgent({});
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json() as AgentRes;
    expect(agent.definition.disabledTools).toEqual([]);
    // a version stored before toolPolicies, and one from before tools were on by default
    await sql`UPDATE capybara.agent_versions
      SET definition = (definition - 'toolPolicies' - 'disabledTools')
        || '{"tools":[{"kind":"builtin","name":"AskUserQuestion"}]}'::jsonb
      WHERE agent_id = ${agent.id}`.execute(raw);
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agent.id}` });
    expect(got.statusCode).toBe(200);
    const read = (got.json() as AgentRes).agent.definition;
    expect(read.disabledTools).toEqual([]);
    expect("tools" in read).toBe(false);
  });

  it("a request carrying the old tools list or a sub-agent filter is refused", async () => {
    const old = await createAgent({ tools: [{ kind: "builtin", name: "AskUserQuestion" }] });
    expect(old.statusCode).toBe(400);
    const filter = await createAgent({ subagentTools: { deny: ["Bash"] } });
    expect(filter.statusCode).toBe(400);
  });

  it("turns off builtins, extension tools and connector tools and tightens policies; stores the canonical list", async () => {
    const connectorId = await installConnector("docs");
    const res = await createAgent({
      disabledTools: [
        { kind: "connector", connectorId, tools: ["write", "read", "write"] },
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "plugin", plugin: "tools-probe", tools: "all" },
        { kind: "builtin", name: "AskUserQuestion" },
      ],
      toolPolicies: {
        mcp__docs__read: "ask",
        mcp__docs__write: "deny",
        "plugin__tools-probe__echo": "deny",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const def = (res.json() as AgentRes).agent.definition;
    expect(def.disabledTools).toEqual([
      { kind: "connector", connectorId, tools: ["read", "write"] },
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "plugin", plugin: "tools-probe", tools: "all" },
    ]);
    // a policy on a turned-off tool is kept (it applies again once the tool is back on)
    expect(def.toolPolicies).toEqual({
      mcp__docs__read: "ask",
      mcp__docs__write: "deny",
      "plugin__tools-probe__echo": "deny",
    });
  });

  it("a missing connector, another org's, a missing connector tool → 400 at disabledTools.<i>", async () => {
    const connectorId = await installConnector("docs");
    const missing = await createAgent({
      disabledTools: [
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "connector", connectorId: randomUUID(), tools: "all" },
      ],
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(detailPaths(missing)).toEqual(["disabledTools.1"]);

    const otherOrg = await createOrg("Other");
    const foreign = await installConnector("theirs", otherOrg);
    const cross = await createAgent({
      disabledTools: [{ kind: "connector", connectorId: foreign, tools: "all" }],
    });
    expect(cross.statusCode).toBe(400);
    expect(detailPaths(cross)).toEqual(["disabledTools.0"]);

    const noTool = await createAgent({
      disabledTools: [{ kind: "connector", connectorId, tools: ["read", "nope"] }],
    });
    expect(noTool.statusCode).toBe(400);
    expect(detailPaths(noTool)).toEqual(["disabledTools.0"]);

    // a soft-deleted connector does not exist either
    expect(
      (await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` }))
        .statusCode,
    ).toBe(204);
    const deleted = await createAgent({
      disabledTools: [{ kind: "connector", connectorId, tools: "all" }],
    });
    expect(deleted.statusCode).toBe(400);
  });

  it("an unknown builtin, a registry-managed builtin and a missing extension tool → 400", async () => {
    for (const name of ["rm_rf", "ToolSearch", "SendMessage"]) {
      const builtin = await createAgent({ disabledTools: [{ kind: "builtin", name }] });
      expect(builtin.statusCode, name).toBe(400);
      expect(detailPaths(builtin)).toEqual(["disabledTools.0"]);
    }
    const plugin = await createAgent({
      disabledTools: [{ kind: "plugin", plugin: "tools-probe", tools: ["missing"] }],
    });
    expect(plugin.statusCode).toBe(400);
    expect(detailPaths(plugin)).toEqual(["disabledTools.0"]);
    const noExtension = await createAgent({
      disabledTools: [{ kind: "plugin", plugin: "nope", tools: "all" }],
    });
    expect(noExtension.statusCode).toBe(400);
  });

  it("toolPolicies: allow only on a connector's tool (decision 2026-11-09); a key that is no tool the agent could have → 400", async () => {
    await installConnector("docs");
    const connectorAllow = await createAgent({ toolPolicies: { mcp__docs__write: "allow" } });
    expect(connectorAllow.statusCode, connectorAllow.body).toBe(201);
    const loosen = await createAgent({ toolPolicies: { AskUserQuestion: "allow" } });
    expect(loosen.statusCode).toBe(400);
    expect(detailPaths(loosen)).toEqual(["toolPolicies.AskUserQuestion"]);

    const unknown = await createAgent({
      toolPolicies: { mcp__docs__nope: "deny", AskUserQuestion: "ask", mcp__other__x: "ask" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(detailPaths(unknown)).toEqual([
      "toolPolicies.mcp__docs__nope",
      "toolPolicies.mcp__other__x",
    ]);

    // PATCH checks too
    const ok = await createAgent({});
    const { agent } = ok.json() as AgentRes;
    const patched = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: {
        definition: { name: "Helper", model: MODEL, toolPolicies: { mcp__docs__nope: "deny" } },
      },
    });
    expect(patched.statusCode).toBe(400);
    expect(detailPaths(patched)).toEqual(["toolPolicies.mcp__docs__nope"]);
  });
});

describe("Platform per-operation policy keys (Platform tool spec §6.2)", () => {
  it("Platform:<op> keys are accepted (Platform is a builtin every agent can have); a malformed one is refused", async () => {
    const withPlatform = await createAgent({
      toolPolicies: { "Platform:skills.create": "deny" },
    });
    expect(withPlatform.statusCode, withPlatform.body).toBe(201);
    expect((withPlatform.json() as AgentRes).agent.definition.toolPolicies).toEqual({
      "Platform:skills.create": "deny",
    });

    // turned off, its policies are kept like any turned-off tool's
    const off = await createAgent({
      disabledTools: [{ kind: "builtin", name: "Platform" }],
      toolPolicies: { "Platform:skills.create": "deny" },
    });
    expect(off.statusCode, off.body).toBe(201);

    const malformed = await createAgent({
      toolPolicies: { "Platform:BAD": "deny" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(detailPaths(malformed)).toEqual(["toolPolicies.Platform:BAD"]);

    // an unknown operation id is kept: a removed operation's policy is harmless
    const gone = await createAgent({
      toolPolicies: { "Platform:gone-domain.do-it": "ask" },
    });
    expect(gone.statusCode, gone.body).toBe(201);
    expect((gone.json() as AgentRes).agent.definition.toolPolicies).toEqual({
      "Platform:gone-domain.do-it": "ask",
    });

    // a domain without a verb, and another tool's prefix, are refused
    for (const key of ["Platform:skills", "Other:skills.create"]) {
      const refused = await createAgent({
        toolPolicies: { [key]: "deny" },
      });
      expect(refused.statusCode, key).toBe(400);
      expect(detailPaths(refused)).toEqual([`toolPolicies.${key}`]);
    }
  });
});

describe("运行时：工具带入请求，不可用工具写提醒（Review Focus 4）", () => {
  /** 建会话行并写一条用户消息；返回会话 id。 */
  async function conversation(agentId: string, text: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${id}, ${orgId}, ${agentId}, ${ownerId})`.execute(raw);
    await k.app.get(EventLog).append(id, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text }], authorAccountId: ownerId },
      },
    ]);
    return id;
  }

  const step = (agent: AgentDefinition, conversationId: string, runId: string, n: number) =>
    runModelStep(k.app.get(RunSteps).deps, {
      orgId,
      conversationId,
      runId,
      step: n,
      agent,
      agentVersion: 1,
      absorbedUpToSeq: 1_000_000,
      signal: new AbortController().signal,
      sink: () => {},
    });

  const ofType = async <T extends ConversationEvent["type"]>(id: string, type: T) =>
    (await k.app.get(EventLog).readAfter(id, 0, 1000)).filter(
      (e) => e.type === type,
    ) as (ConversationEvent & {
      payload: EventPayload<T>;
    })[];

  /** Every builtin and the connector extension's own `echo` off: only what a test adds is on. */
  const quiet = () => [
    ...builtinsOff(),
    { kind: "plugin" as const, plugin: "mem-connector", tools: "all" as const },
  ];

  /** The keys `forAgent` resolves for `agent` now. */
  const keysOf = async (agent: AgentDefinition) =>
    (await k.app.get(ToolRegistry).forAgent(orgId, agent)).tools.map((t) => t.key);

  it("model_call.request.tools records the tools by key with their spec hashes", async () => {
    await installConnector("docs");
    const res = await createAgent({ disabledTools: quiet() });
    const { agent } = res.json() as AgentRes;
    const convId = await conversation(agent.id, "hello");
    const r = await step(agent.definition, convId, randomUUID(), 1);
    expect(r.aborted).toBe(false);
    const [call] = await ofType(convId, "model_call");
    const { tools } = await k.app.get(ToolRegistry).forAgent(orgId, agent.definition);
    const hash = (key: string) => tools.find((t) => t.key === key)?.specHash;
    expect(call?.payload.request.tools).toEqual([
      { key: "mcp__docs__read", specHash: hash("mcp__docs__read") },
      { key: "mcp__docs__write", specHash: hash("mcp__docs__write") },
    ]);
    expect(await ofType(convId, "reminder")).toEqual([]);
  });

  it("a builtin added after an agent was saved appears for it; a turned-off one stays off", async () => {
    // a version stored before tools were on by default, without CurrentTime in its list
    const res = await createAgent({ disabledTools: [{ kind: "builtin", name: "Platform" }] });
    const { agent } = res.json() as AgentRes;
    await sql`UPDATE capybara.agent_versions
      SET definition = (definition - 'disabledTools')
        || '{"tools":[{"kind":"builtin","name":"AskUserQuestion"}]}'::jsonb
      WHERE agent_id = ${agent.id}`.execute(raw);
    const read = (
      (
        await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agent.id}` })
      ).json() as AgentRes
    ).agent.definition;
    const legacy = await keysOf(read);
    expect(legacy).toContain("CurrentTime");
    expect(legacy).toContain("Platform");
    expect(legacy).toContain("AskUserQuestion");

    const off = await keysOf(agent.definition);
    expect(off).toContain("CurrentTime");
    expect(off).not.toContain("Platform");
  });

  it("a connector the org adds later appears for every agent unless turned off", async () => {
    const res = await createAgent({ disabledTools: quiet() });
    const { agent } = res.json() as AgentRes;
    expect(await keysOf(agent.definition)).toEqual([]);
    const connectorId = await installConnector("docs");
    expect(await keysOf(agent.definition)).toEqual(["mcp__docs__read", "mcp__docs__write"]);
    const partly: AgentDefinition = {
      ...agent.definition,
      disabledTools: [
        ...agent.definition.disabledTools,
        { kind: "connector", connectorId, tools: ["write"] },
      ],
    };
    expect(await keysOf(partly)).toEqual(["mcp__docs__read"]);
    const whole: AgentDefinition = {
      ...agent.definition,
      disabledTools: [
        ...agent.definition.disabledTools,
        { kind: "connector", connectorId, tools: "all" },
      ],
    };
    expect(await keysOf(whole)).toEqual([]);
  });

  it("an extension's tools appear once the org enables it; the org's per-tool switch wins", async () => {
    const res = await createAgent({ disabledTools: quiet() });
    const { agent } = res.json() as AgentRes;
    expect(await keysOf(agent.definition)).toEqual([]);
    const enable = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/tools-probe`,
      payload: { enabled: true },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const on = await keysOf(agent.definition);
    expect(on).toContain("plugin__tools-probe__echo");
    // the org admin turns the tool off org-wide: no agent gets it, and the model is not told
    await sql`INSERT INTO capybara.org_tool_switches (org_id, plugin, tool, enabled)
      VALUES (${orgId}, 'tools-probe', 'echo', false)`.execute(raw);
    const switched = await k.app.get(ToolRegistry).forAgent(orgId, agent.definition);
    expect(switched.tools.map((t) => t.key)).not.toContain("plugin__tools-probe__echo");
    expect(switched.unavailable).toEqual([]);
    expect(switched.hidden?.some((h) => h.ref === "plugin__tools-probe__echo")).toBe(true);
  });

  it("tools the agent never asked for are never reported as unavailable: a deleted connector just goes", async () => {
    const connectorId = await installConnector("docs");
    const res = await createAgent({ disabledTools: quiet() });
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json() as AgentRes;
    expect(
      (await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` }))
        .statusCode,
    ).toBe(204);

    const convId = await conversation(agent.id, "hello");
    const runId = randomUUID();
    const r = await step(agent.definition, convId, runId, 1);
    expect(r.aborted).toBe(false);
    expect(r.stopReason).toBe("end_turn");
    expect(await ofType(convId, "reminder")).toEqual([]);
    const [call] = await ofType(convId, "model_call");
    expect(call?.payload.request.tools).toEqual([]);
  });
});
