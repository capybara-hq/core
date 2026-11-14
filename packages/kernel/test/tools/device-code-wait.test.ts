import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DeviceFeature, ToolSpec } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import type { Breaker } from "../../src/tools/breaker.js";
import type { ToolOutputs } from "../../src/tools/outputs.js";
import type { ToolPipeline, ToolStepContext } from "../../src/tools/pipeline.js";
import {
  type BuiltinHandler,
  type BuiltinResult,
  type ResolvedTool,
  specHash,
} from "../../src/tools/registry.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { eventsOf } from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";
import { webCaller } from "../helpers/step-context.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import {
  approvalsFor,
  breakerFor,
  outputsFor,
  pipelineFor,
  questionsFor,
} from "../helpers/tools.js";

/**
 * The device code under retries and the network-ask wait (auto mode spec §6, P-D13): a real retry
 * that runs the call again keeps one `device_code` event, a second call with the same code shows
 * no second card, and a call that waits on a network ask writes the card once — with the event
 * before the result and never in it.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let outputs: ToolOutputs;
let breaker: Breaker;
const silent = createLogger("error", { write: () => {} });

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => base;

const agent: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledSkills: [],
  disabledTools: builtinsOff(),
  toolPolicies: {},
};

const BASH_SPEC: ToolSpec = {
  name: "Bash",
  description: "Bash tool.",
  inputSchema: { type: "object" },
};
const bashTool: ResolvedTool = {
  key: "Bash",
  source: { kind: "builtin", name: "Bash" },
  spec: BASH_SPEC,
  specHash: specHash(BASH_SPEC),
  defaultPolicy: "allow",
};

/** The code the fake command printed (`gh auth login --web`'s shape). */
const CODE = { url: "https://github.com/login/device", code: "1A2B-C3D4" };

let calls = 0;
/** What the fake builtin returns; the tests vary the loginCode / networkReport fields. */
let resultOf: () => BuiltinResult;

function pipeline(): ToolPipeline {
  const handler: BuiltinHandler = async () => {
    calls++;
    return resultOf();
  };
  return pipelineFor({
    db,
    eventLog,
    registry: {
      forAgent: async () => ({ tools: [bashTool], unavailable: [], hidden: [], toolSearch: false }),
      findConnector: () => undefined,
      handler: (source) =>
        source.kind === "builtin" && source.name === "Bash" ? handler : undefined,
    },
    credentials: {
      async injection() {
        return { headers: {} };
      },
      async onUnauthorized() {},
    },
    breaker,
    outputs,
    approvals: approvalsFor(db, eventLog, config),
    questions: questionsFor(db, eventLog, config),
    config,
    log: silent,
    decidePolicy: async () => "allow",
    networkGrants: {
      runState: async () => ({
        granted: new Set<string>(),
        refused: new Set<string>(),
        asks: 0,
        pending: false,
      }),
    },
    devicePolicy: {
      summary: async () => ({
        features: ["networkReport", "policyOpId"] as DeviceFeature[],
        policy: { mode: "auto" as const, allowedDomains: [] },
      }),
    },
  });
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 10);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
  outputs = outputsFor(db, config);
  breaker = breakerFor(redis, config);
});

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let seed: Awaited<ReturnType<typeof seedConversation>>;
let runId: string;
let deviceId: string;

beforeEach(async () => {
  calls = 0;
  resultOf = () => ({ content: [{ type: "text", text: "ok" }], loginCode: CODE });
  await redis.flushdb();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  seed = await seedConversation(raw);
  runId = randomUUID();
  deviceId = await seedDevice(raw, seed.orgId);
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      status: "running",
      agent_version: 1,
      trigger_account_id: seed.accountId,
      trigger_seq: 0,
    })
    .execute();
});

const stepCtx = (over: Partial<ToolStepContext> = {}): ToolStepContext => ({
  orgId: seed.orgId,
  conversationId: seed.conversationId,
  runId,
  step: 1,
  agentId: seed.agentId,
  agentVersion: 1,
  agent,
  accountId: seed.accountId,
  ...webCaller(seed.accountId),
  signal: new AbortController().signal,
  ...over,
});

/** Writes this step's assistant message with one Bash call. */
async function assistant(callId: string, step = 1): Promise<void> {
  await eventLog.append(seed.conversationId, [
    {
      type: "assistant_message",
      runId,
      idemKey: assistantIdemKey(runId, step),
      payload: {
        step,
        content: [
          {
            type: "tool_call",
            id: callId,
            name: "Bash",
            input: { command: "gh auth login --web", description: "Sign in" },
          },
        ],
        stopReason: "tool_use",
      },
    },
  ]);
}

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const codes = async () => ofType(await eventsOf(db, seed.conversationId), "device_code");

describe("the device code under retries and waits", () => {
  it("a real retry that runs the call again keeps one device_code event", async () => {
    await assistant("c1");
    await pipeline().runStep(stepCtx());
    expect(calls).toBe(1);
    expect(await codes()).toHaveLength(1);

    // a retry lost the call's start and result, not the display-only event: the call runs again
    await sql`DELETE FROM capybara.conversation_events
      WHERE conversation_id = ${seed.conversationId}
        AND type IN ('tool_call_started', 'tool_result')`.execute(raw);
    await pipeline().runStep(stepCtx());
    expect(calls).toBe(2);
    expect(await codes()).toHaveLength(1);
    expect(ofType(await eventsOf(db, seed.conversationId), "tool_result")).toHaveLength(1);
  });

  it("a second call whose output carries the same code does not show it twice", async () => {
    await assistant("c1");
    await pipeline().runStep(stepCtx());
    await assistant("c2", 2);
    await pipeline().runStep(stepCtx({ step: 2 }));
    expect(calls).toBe(2);
    const written = await codes();
    expect(written).toHaveLength(1);
    expect(written[0]?.payload.callId).toBe("c1");
  });

  it("a call that waits on a network ask writes the device code once, before its result", async () => {
    resultOf = () => ({
      content: [{ type: "text", text: "! First copy your one-time code: 1A2B-C3D4" }],
      loginCode: CODE,
      networkReport: {
        deviceId,
        blocked: [{ host: "api.github.com", port: 443, layer: "device" }],
      },
    });
    await assistant("c1");
    const first = await pipeline().runStep(stepCtx());
    expect(first.kind).toBe("suspended");

    const evs = await eventsOf(db, seed.conversationId);
    expect(ofType(evs, "device_code")).toHaveLength(1);
    expect(ofType(evs, "network_blocked")).toHaveLength(1);
    expect(ofType(evs, "tool_result")).toHaveLength(0);

    const ask = await db
      .selectFrom("approvals")
      .select(["id", "detail"])
      .where("conversation_id", "=", seed.conversationId)
      .where("kind", "=", "network")
      .executeTakeFirstOrThrow();
    // the kept result carries the device code so the resumed write can show it
    const kept = ask.detail as { result?: { loginCode?: unknown } } | null;
    expect(kept?.result?.loginCode).toEqual(CODE);
    await sql`UPDATE capybara.approvals SET status = 'approved', scope = 'once',
      decided_by = ${seed.accountId}, decided_at = now() WHERE id = ${ask.id}`.execute(raw);

    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    const after = await eventsOf(db, seed.conversationId);
    expect(ofType(after, "device_code")).toHaveLength(1);
    expect(ofType(after, "tool_result")).toHaveLength(1);
    const result = ofType(after, "tool_result")[0];
    // the event sits before the result, and the result never carries the field
    expect(after.findIndex((e) => e.type === "device_code")).toBeLessThan(
      after.findIndex((e) => e.type === "tool_result"),
    );
    expect(result?.payload).not.toHaveProperty("loginCode");
    expect(JSON.stringify(result?.payload)).not.toContain("loginCode");
  });
});
