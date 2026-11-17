import { randomUUID } from "node:crypto";
import {
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  SandboxScopeDeniedError,
  MODEL_PROVIDER_EXTENSION_POINT_V2 as V2,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, PermissionContextV1 } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { createLogger } from "../../src/log.js";
import { COMPACTION_SETTINGS } from "../../src/runtime/compaction-settings.service.js";
import { COMPACTION_MARKER } from "../../src/runtime/context/compaction.js";
import {
  permissionContextIdemKey,
  permissionContextText,
  RecordedPermissionContextError,
} from "../../src/runtime/context/permission-profile.js";
import type { HookRunner } from "../../src/runtime/hook-calls.js";
import {
  type ModelStepDeps,
  type PermissionContextRequestInput,
  RunError,
  runFinalWrapUp,
  runModelStep,
} from "../../src/runtime/model-call.js";
import { PERMISSION_CONTEXT_RUN_ERRORS } from "../../src/runtime/permission-context-errors.js";
import { ExecutionRevoked } from "../../src/runtime/run-execution.js";
import { PermissionContextSubjectChanged } from "../../src/sandbox/permission-context-types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { providerRegistryFor, stepLogFor } from "../helpers/runtime.js";

/**
 * Gate 9.4 (permission context replay spec B2): the request boundary of every agent-history
 * request construction in the attempt ladder, over `runModelStep` with a stub provider. The port
 * here appends `permission_context` snapshots the way the live recorder does (the recorder itself:
 * `permission-context-requests.test.ts`), or fails.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let deps: ModelStepDeps;
let baseConfig: KernelConfig;

const silent = createLogger("error", { write: () => {} });
const ALL_ABSORBED = 1_000_000_000;

const stubInfo = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 32_000,
  maxOutputTokens: 4096,
  capabilities: {
    tools: false,
    vision: false,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
    effort: false,
  },
  parameters: [],
  ...extra,
});

/** Every provider request in order; `respond` returning text streams it, throwing fails the call. */
const calls: ModelRequest[] = [];
let respond: (req: ModelRequest) => string | Promise<string> = () => "ok";
const stubImpl: ModelProvider = {
  async listModels() {
    return [
      stubInfo("main"),
      stubInfo("backup"),
      stubInfo("small", { contextWindow: 2000, maxOutputTokens: 100 }),
    ];
  },
  async *stream(req): AsyncGenerator<ModelStreamEvent> {
    calls.push(structuredClone(req));
    const text = await respond(req);
    yield { type: "text_delta", text };
    yield {
      type: "message_complete",
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  baseConfig = KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    extensions: [MODEL_FAKE],
    extensionPermissions: { autoApprove: true },
  });
  k = await startKernel(baseConfig, { env: {}, logger: silent });
  raw = createDb(pgc.url, 10);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
  const registry = providerRegistryFor(
    {
      list: (cap: string) => [
        ...k.app.get(ExtensionHost).list(cap),
        { plugin: "stub", capability: V2, impl: stubImpl },
      ],
    },
    redis,
  );
  deps = {
    db,
    eventLog,
    stepLog: stepLogFor(db, eventLog),
    registry,
    config: { get: () => baseConfig },
    compactionSettings: {
      resolve: async () => ({ ...COMPACTION_SETTINGS.parse({}), reserveTokens: 0 }),
    },
    tools: k.app.get(ToolRegistry),
    log: silent,
  };
});

afterAll(async () => {
  await k?.close();
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let conversationId: string;
let accountId: string;
let agentId: string;
let runId: string;
let orgId: string;

beforeEach(async () => {
  await redis.flushdb();
  calls.length = 0;
  respond = () => "ok";
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  accountId = randomUUID();
  orgId = randomUUID();
  agentId = randomUUID();
  conversationId = await newConversation();
  runId = randomUUID();
});

async function newConversation(): Promise<string> {
  const id = randomUUID();
  if (
    (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM capybara.orgs WHERE id = ${orgId}`.execute(raw)
    ).rows[0]?.n === 0
  ) {
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
      VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  }
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${id}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  return id;
}

const agentWith = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "main" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledTools: builtinsOff(),
  disabledSkills: [],
  toolPolicies: {},
  ...over,
});

const say = async (text: string, conv = conversationId) => {
  await eventLog.append(conv, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text }], authorAccountId: accountId },
    },
  ]);
};

const answer = async (text: string) => {
  await eventLog.append(conversationId, [
    {
      type: "assistant_message",
      runId: "old-run",
      payload: { step: 1, content: [{ type: "text", text }], stopReason: "end_turn" },
    },
  ]);
};

type StepOver = {
  step?: number;
  agent?: AgentDefinition;
  signal?: AbortSignal;
  conversationId?: string;
  accountId?: string | null;
};
const stepInput = (over: StepOver = {}) => ({
  source: "web" as const,
  orgId,
  conversationId: over.conversationId ?? conversationId,
  runId,
  step: over.step ?? 1,
  agent: over.agent ?? agentWith(),
  agentVersion: 1,
  absorbedUpToSeq: ALL_ABSORBED,
  signal: over.signal ?? new AbortController().signal,
  sink: () => {},
  ...(over.accountId !== null && { accountId: over.accountId ?? accountId }),
  agentId,
  conversationKind: "chat" as const,
});
const step = (d: ModelStepDeps, over: StepOver = {}) => runModelStep(d, stepInput(over));

const all = (conv = conversationId) => eventLog.readAfter(conv, 0, 10_000);
const ofType = async <T extends ConversationEvent["type"]>(type: T, conv = conversationId) =>
  (await all(conv)).filter((e) => e.type === type) as Extract<ConversationEvent, { type: T }>[];

/** A complete supported v1 snapshot whose working directory tells snapshots apart. */
const snapshot = (label: string, conv = conversationId): PermissionContextV1 => ({
  version: 1,
  rootConversationId: conv,
  profileRevision: 0,
  selectedProfile: "request-approval",
  effectiveProfile: "request-approval",
  execution: "interactive",
  inherited: false,
  deviceId: "00000000-0000-4000-8000-000000000002",
  scopeRevision: "scope-1",
  authorityRevision: "authority-1",
  availability: { state: "supported" },
  scope: {
    location: "local",
    workingRoot: `/project-${label}`,
    filesystem: {
      kind: "scoped",
      readDirectories: [`/project-${label}`],
      writeDirectories: [`/project-${label}`],
    },
    network: { kind: "none" },
    outerNetwork: { kind: "host-environment" },
  },
});
const textOf = (label: string) => permissionContextText(snapshot(label));
const carries = (req: ModelRequest | undefined, label: string) =>
  JSON.stringify(req).includes(JSON.stringify(textOf(label)).slice(1, -1));

/** Appends `payload` as a recorder would (predecessor identity), into the calling conversation. */
async function appendContext(conv: string, payload: PermissionContextV1): Promise<number> {
  const prior = (await ofType("permission_context", conv)).at(-1);
  const [e] = await eventLog.append(conv, [
    {
      type: "permission_context",
      runId,
      idemKey: permissionContextIdemKey(payload, prior?.seq ?? 0),
      payload,
    },
  ]);
  return e?.seq ?? 0;
}

/**
 * A port that records the "current" snapshot (`current()`) on every call, the live recorder's
 * observable behaviour: nothing when it equals the latest recorded one.
 */
function recordingPort(current: () => string) {
  const inputs: PermissionContextRequestInput[] = [];
  let last: string | undefined;
  return {
    inputs,
    port: {
      async beforeRequest(input: PermissionContextRequestInput) {
        inputs.push(input);
        const label = current();
        if (label === last) return;
        last = label;
        await appendContext(input.conversationId, snapshot(label, input.conversationId));
      },
    },
  };
}

const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("permission context request boundary", () => {
  it("without a port there is no call and no reread: the request and its toSeq are the old ones", async () => {
    const other = await newConversation();
    await say("hello");
    await say("hello", other);
    const reads = vi.spyOn(eventLog, "readAfter");
    try {
      await step(deps);
      const absentReads = reads.mock.calls.length;
      reads.mockClear();
      let called = 0;
      await step(
        { ...deps, permissionContext: { beforeRequest: async () => void called++ } },
        { conversationId: other },
      );
      // the same construction plus exactly one complete-log read after the callback
      expect(called).toBe(1);
      expect(reads.mock.calls.length).toBe(absentReads + 1);
    } finally {
      reads.mockRestore();
    }
    // nothing was appended: both conversations built byte-identical requests and metadata
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    const [a] = await ofType("model_call");
    const [b] = await ofType("model_call", other);
    expect(b?.payload).toEqual(a?.payload);
    expect(a?.payload.request).not.toHaveProperty("permissionContext");
  });

  it("records per construction: a retry and the fallback each see the context recorded during the delay", async () => {
    await say("hello");
    let current = "a";
    const { inputs, port } = recordingPort(() => current);
    let n = 0;
    respond = (req) => {
      n++;
      // the profile changes after this request was built and sent (during the retry delay)
      if (req.model === "main") {
        current = n === 1 ? "b" : "c";
        throw new ModelError("overloaded", "busy", { retryAfterMs: 1 });
      }
      return "from backup";
    };
    const agent = agentWith({ fallback: { provider: "stub", model: "backup" } });
    const r = await step({ ...deps, permissionContext: port }, { agent });
    expect(r.content).toEqual([{ type: "text", text: "from backup" }]);
    expect(inputs.map((i) => i.attempt)).toEqual([1, 2, 3]);
    expect(inputs.every((i) => i.step === 1 && i.accountId === accountId)).toBe(true);
    expect(calls).toHaveLength(3);
    // each request carries what was recorded before it, append-only, and nothing later
    expect([carries(calls[0], "a"), carries(calls[0], "b")]).toEqual([true, false]);
    expect([carries(calls[1], "a"), carries(calls[1], "b"), carries(calls[1], "c")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(carries(calls[2], "c")).toBe(true);
    const contexts = await ofType("permission_context");
    const models = await ofType("model_call");
    expect(models.map((m) => m.payload.request.permissionContext?.contextSeq)).toEqual(
      contexts.map((c) => c.seq),
    );
    // every snapshot precedes the request that carries it
    for (const [i, m] of models.entries()) expect(contexts[i]?.seq ?? 0).toBeLessThan(m.seq);
  });

  it("two builds in one attempt around a forced compaction record A then B, the rebuild passing the boundary", async () => {
    // an earlier summary of ~3000 tokens: the agent's model holds it, the fallback's 2000-token
    // window cannot and its fit plan never drops it, so the fallback rung compacts with its own
    // model inside the attempt and builds again
    await say("old");
    await answer("old answer");
    const covered = (await all()).at(-1) as ConversationEvent;
    await eventLog.append(conversationId, [
      {
        type: "compaction_summary",
        runId: "old-run",
        payload: { coversUpToSeq: covered.seq, text: `Summary: ${"o".repeat(12_000)}` },
      },
    ]);
    for (let i = 0; i < 6; i++) {
      await say(`turn ${i} `.padEnd(400, "x"));
      await answer(`turn ${i} `.padEnd(400, "x"));
    }
    await say("go");
    let current = "a";
    const { inputs, port } = recordingPort(() => current);
    respond = (req) => {
      if (req.system.some((x) => x.text.includes(COMPACTION_MARKER))) {
        // the profile changes while the compaction call runs, between the two builds
        current = "b";
        return `Summary: ${"s".repeat(300)}`;
      }
      if (req.model === "main") throw new ModelError("server", "down", { retryAfterMs: 1 });
      return "done";
    };
    const d: ModelStepDeps = {
      ...deps,
      permissionContext: port,
      compactionSettings: {
        resolve: async () => ({
          ...COMPACTION_SETTINGS.parse({}),
          enabled: false,
          reserveTokens: 0,
        }),
      },
    };
    const agent = agentWith({ fallback: { provider: "stub", model: "small" } });
    expect((await step(d, { agent })).content).toEqual([{ type: "text", text: "done" }]);
    // main twice, then the fallback attempt builds twice (before and after its compaction)
    expect(inputs.map((i) => i.attempt)).toEqual([1, 2, 3, 3]);
    const contexts = await ofType("permission_context");
    const summary = (await ofType("compaction_summary")).at(-1);
    const rows = await ofType("model_call");
    expect(rows.map((r) => r.payload.model)).toEqual(["main", "main", "small"]);
    expect(contexts.map((c) => c.payload.scope?.workingRoot)).toEqual(["/project-a", "/project-b"]);
    expect(summary?.seq ?? 0).toBeLessThan(contexts[1]?.seq ?? 0);
    expect(rows[2]?.payload.request.summarySeq).toBe(summary?.seq);
    expect(rows[2]?.payload.request.permissionContext?.contextSeq).toBe(contexts[1]?.seq);
    const sent = calls.filter((c) => !c.system.some((x) => x.text.includes(COMPACTION_MARKER)));
    expect(sent).toHaveLength(3);
    expect(carries(sent[2], "b")).toBe(true);
    // the compaction request never carries a permission instruction
    const compactions = calls.filter((c) =>
      c.system.some((x) => x.text.includes(COMPACTION_MARKER)),
    );
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.some((c) => carries(c, "a") || carries(c, "b"))).toBe(false);
  });

  it("a change during model.request hook processing leaves the built request unchanged; the next build sees it", async () => {
    await say("hello");
    const hooks = {
      has: (mount: string) => mount === "model.request",
      run: async (mount: string) => {
        if (mount === "model.request" && (await ofType("permission_context")).length === 1)
          await appendContext(conversationId, snapshot("b"));
        return { allowed: true };
      },
    } as unknown as HookRunner;
    const { port } = recordingPort(() => "a");
    const d: ModelStepDeps = { ...deps, permissionContext: port, hooks };
    await step(d);
    expect(carries(calls[0], "a")).toBe(true);
    expect(carries(calls[0], "b")).toBe(false);
    const contexts = await ofType("permission_context");
    const [first] = await ofType("model_call");
    expect(first?.payload.request.permissionContext?.contextSeq).toBe(contexts[0]?.seq);
    expect(contexts).toHaveLength(2);
    await step(d, { step: 2 });
    expect(carries(calls[1], "b")).toBe(true);
  });

  it("the final wrap-up request passes the boundary too", async () => {
    await say("hello");
    const { inputs, port } = recordingPort(() => "wrap");
    await runFinalWrapUp(
      { ...deps, permissionContext: port },
      { ...stepInput(), step: 3 },
      "budget",
    );
    expect(inputs.map((i) => [i.step, i.attempt])).toEqual([[3, 1]]);
    expect(carries(calls[0], "wrap")).toBe(true);
  });

  it("a revoked execution reaches the caller as the identical object, before an abort, with no send", async () => {
    await say("hello");
    const revoked = new ExecutionRevoked();
    const ac = new AbortController();
    const err = await rejection(
      step(
        {
          ...deps,
          permissionContext: {
            beforeRequest: async () => {
              ac.abort();
              throw revoked;
            },
          },
        },
        { signal: ac.signal },
      ),
    );
    expect(err).toBe(revoked);
    expect(calls).toEqual([]);
    expect(await ofType("model_call")).toEqual([]);
    expect(await ofType("assistant_message")).toEqual([]);
  });

  it("an ordinary abort during the callback is the existing aborted step, nothing sent", async () => {
    await say("hello");
    const ac = new AbortController();
    const r = await step(
      {
        ...deps,
        permissionContext: {
          beforeRequest: async () => {
            ac.abort();
            throw new DOMException("aborted", "AbortError");
          },
        },
      },
      { signal: ac.signal },
    );
    expect(r.aborted).toBe(true);
    expect(calls).toEqual([]);
  });

  it("maps callback and refresh failures to the named no-send run errors, never a provider error or fallback", async () => {
    const storage = Object.assign(new Error("connection lost"), { code: "08006" });
    const cases: [unknown, keyof typeof PERMISSION_CONTEXT_RUN_ERRORS][] = [
      [new SandboxScopeDeniedError("not applied"), "stale"],
      [new PermissionContextSubjectChanged(), "changed"],
      [storage, "unavailable"],
      [new RecordedPermissionContextError(3, "permission_context"), "invalid"],
      [new Error("unexpected"), "invalid"],
      [new ApiError("forbidden", "gone"), "actor"],
      [
        new RunError(
          PERMISSION_CONTEXT_RUN_ERRORS.changed.code,
          PERMISSION_CONTEXT_RUN_ERRORS.changed.message,
        ),
        "changed",
      ],
    ];
    const agent = agentWith({ fallback: { provider: "stub", model: "backup" } });
    for (const [thrown, kind] of cases) {
      const conv = await newConversation();
      await say("hello", conv);
      const err = await rejection(
        step(
          {
            ...deps,
            permissionContext: {
              beforeRequest: async () => {
                throw thrown;
              },
            },
          },
          { conversationId: conv, agent },
        ),
      );
      expect(err).toBeInstanceOf(RunError);
      expect((err as RunError).code, String(thrown)).toBe(PERMISSION_CONTEXT_RUN_ERRORS[kind].code);
      expect((err as RunError).message).toBe(PERMISSION_CONTEXT_RUN_ERRORS[kind].message);
      expect(await ofType("model_call", conv)).toEqual([]);
    }
    expect(calls).toEqual([]);

    // the complete-log refresh after a successful callback: storage unavailable, nothing sent
    const conv = await newConversation();
    await say("hello", conv);
    let refreshing = false;
    const real = eventLog.readAfter.bind(eventLog);
    const reads = vi.spyOn(eventLog, "readAfter").mockImplementation(async (...a) => {
      if (refreshing) throw storage;
      return real(...a);
    });
    try {
      const err = await rejection(
        step(
          {
            ...deps,
            permissionContext: {
              beforeRequest: async () => {
                refreshing = true;
              },
            },
          },
          { conversationId: conv, agent },
        ),
      );
      expect((err as RunError).code).toBe(PERMISSION_CONTEXT_RUN_ERRORS.unavailable.code);
    } finally {
      reads.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it("a step without an actor fails as actor-unavailable before the callback", async () => {
    await say("hello");
    let called = false;
    const err = await rejection(
      step(
        {
          ...deps,
          permissionContext: {
            beforeRequest: async () => {
              called = true;
            },
          },
        },
        { accountId: null },
      ),
    );
    expect((err as RunError).code).toBe(PERMISSION_CONTEXT_RUN_ERRORS.actor.code);
    expect(called).toBe(false);
    expect(calls).toEqual([]);
  });
});
