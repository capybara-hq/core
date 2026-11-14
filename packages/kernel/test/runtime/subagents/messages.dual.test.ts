import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { SubagentMessages } from "../../../src/runtime/subagents/messages.js";
import { SubagentsService } from "../../../src/runtime/subagents/subagents.service.js";
import { sentToRunningText } from "../../../src/tools/builtins/send-message.js";
import type { ToolStepContext } from "../../../src/tools/pipeline.js";
import type { ScriptRule } from "../../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../../helpers/conversations.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../../helpers/http.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  startKernel,
  type TestKernel,
  waitFor,
} from "../../helpers/runs.js";
import { webCaller } from "../../helpers/step-context.js";

/**
 * Agent map spec §5.1 (Task A6), two replicas: two in-process kernels sharing PG and Redis, each
 * with its own pool, HTTP app and services. Replica A has no worker, so every run executes on
 * replica B; a `SendMessage` posted through A's services reaches the child B runs, which absorbs it
 * at its next model call (the log in PG is the only channel).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const RULES: ScriptRule[] = [
  { when: { systemIncludes: CHILD, lastUserIncludes: "CROSS-PING" }, reply: { text: "absorbed" } },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "dual-step", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Read", input: { file_path: "/workspace/none.txt" } }],
      barrier: { name: "dual-step", count: 99, timeoutMs: 60_000 },
    },
  },
];

type Barriers = Map<string, { arrived: number; waiters: (() => void)[] }>;
const barriers = (): Barriers | undefined =>
  (globalThis as { __modelScript?: { barriers: Barriers } }).__modelScript?.barriers;
const release = (name: string) => {
  for (const w of barriers()?.get(name)?.waiters.splice(0) ?? []) w();
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let a: TestKernel;
let b: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-messages-dual-"));
  const config = (roles: ("api" | "worker")[]) =>
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles,
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    );
  b = await startKernel(config(["api", "worker"]));
  a = await startKernel(config(["api"]));
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = asUser(a.http, cookieJar());
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins(["Agent", "Read"].map((name) => ({ kind: "builtin", name }))),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  release("dual-step");
  await a?.close();
  await b?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

describe("SendMessage across replicas", () => {
  it("a message posted on replica A is absorbed by a child running on replica B", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const runId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "running",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: 0,
      })
      .execute();
    const v = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    const ctx: ToolStepContext = {
      orgId,
      conversationId: conv,
      runId,
      step: 1,
      agentId,
      agentVersion: 1,
      agent: normalizeStoredDefinition(v.definition),
      accountId: ownerId,
      ...webCaller(ownerId),
      signal: new AbortController().signal,
    };
    // dispatched through A; only B has workers, so the child runs on B
    const out = await a.app.get(SubagentsService).dispatch({
      ctx,
      callId: "c1",
      input: { description: "Remote", prompt: "dual-step: go" },
    });
    if (out.kind !== "dispatched") throw new Error(out.content);
    const childId = out.childConversationId;
    await waitFor(
      async () => (barriers()?.get("dual-step")?.waiters.length ?? 0) >= 1,
      30_000,
      "the child held on B",
    );
    const sent = await a.app.get(SubagentMessages).toChild(ctx, "s1", childId, "CROSS-PING: hi");
    expect(sent).toEqual({
      content: sentToRunningText({ id: childId, description: "Remote" }),
      isError: false,
    });
    release("dual-step");
    const events = await waitFor(
      async () => {
        const e = await eventsOf(db, childId);
        return ofType(e, "run_finished").length === 1 ? e : null;
      },
      30_000,
      "the child's run finished",
    );
    const reply = ofType(events, "assistant_message")
      .at(-1)
      ?.payload.content.flatMap((x) => (x.type === "text" ? [x.text] : []))
      .join("");
    expect(reply).toBe("absorbed");
    expect(ofType(events, "run_started")).toHaveLength(1);
    const message = ofType(events, "user_message").at(-1);
    expect(message?.payload.dispatch).toMatchObject({ callId: "s1", kind: "message" });
    expect(ofType(events, "run_finished")[0]?.payload.consumedUpToSeq).toBeGreaterThanOrEqual(
      message?.seq ?? Number.POSITIVE_INFINITY,
    );
  });
});
