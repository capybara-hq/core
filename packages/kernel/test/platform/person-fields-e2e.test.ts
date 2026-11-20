import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { personFieldParams, secretFieldsOf } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { SealedInputs } from "../../src/platform/sealed-inputs.js";
import { TOOL_PIPELINE_HOOKS } from "../../src/tools/pipeline.js";
import { createDecidePolicy } from "../../src/tools/policy.js";
import { scriptRules } from "../fixtures/plugins/model-script/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Person fields through the `Platform` tool and the pipeline (platform web parity spec §4, Task 4):
 * a write whose target has a secret field asks the person on the card, always once and never under
 * a grant or an `allow` override (R6), never in an unattended run, never as a role escalation (R5),
 * and the handler gets the sealed values only through `personInputs`. A test-only operation is
 * registered through `PlatformOperations.register` after the start.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const OP = "platform.probe-secret";
const SECRET = "sk-live-probe-0123456789";
const EXPIRED_TEXT =
  "The values the person entered expired before they were applied; call the operation again.";
const R5_TEXT =
  "This write needs the person you work for to enter values; they lack the role. Ask an admin to do it on the web.";
const UNATTENDED_TEXT =
  "This write needs the person to enter values on the web; it cannot run unattended.";

/** The probe target: one optional secret field. */
const TARGET_SCHEMA = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string", "x-secret": true, title: "API key" },
  },
};

/** What the probe's handler saw, per run. */
const seen: { paths: readonly string[] | null; value: string | null }[] = [];

const ProbeInput = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  askPerson: personFieldParams.askPerson,
  clearSecrets: personFieldParams.clearSecrets,
});

const probe = defineOperation({
  id: OP,
  description: "Test only: stores a probe config.",
  input: ProbeInput,
  example: { values: {}, askPerson: ["apiKey"], clearSecrets: [] },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "personal",
  summary: () => ({ zh: "保存探针配置", en: "Save the probe config" }),
  personFields: async () => ({
    target: { zh: "探针配置", en: "Probe config" },
    ...secretFieldsOf(TARGET_SCHEMA, new Set()),
  }),
  run: async (_input, ctx) => {
    const pi = ctx.personInputs;
    if (pi === undefined) {
      seen.push({ paths: null, value: null });
      return { stored: true };
    }
    const value = await pi.apply(async (values) => values.apiKey ?? null);
    seen.push({ paths: pi.paths, value });
    return { stored: true };
  },
}) as PlatformOperation;

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
/** Conversations whose asks the decision seam turns into role escalations (R5). */
const escalated = new Set<string>();
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  const decide = createDecidePolicy(db);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, MODEL_SCRIPT] },
    ),
    {
      logger: createLogger("debug", { write: (line) => lines.push(line) }),
      overrides: [
        {
          provide: TOOL_PIPELINE_HOOKS,
          useValue: {
            decidePolicy: async (tool, def, c) => {
              const d = await decide(tool, def, c);
              if (escalated.has(c.conversationId) && typeof d === "object" && "ask" in d) {
                return {
                  ask: { ...d.ask, requestedFor: null, approverRole: "admin", policy: "role" },
                };
              }
              return d;
            },
          },
        },
      ],
    },
  );
  k.app.get(PlatformOperations).register([probe]);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent("Mine");
});

/** A private agent of the owner with only the `Platform` builtin; returns its id. */
async function createAgent(name: string, model = { provider: "model-fake", model: "fake-1" }) {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Be helpful.",
        model,
        disabledTools: builtinsOff("Platform"),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const callText = (params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation: OP, params })}`;

/** Posts a probe call in a new conversation; returns the conversation id. */
async function probeCall(params: Record<string, unknown>, agent = agentId): Promise<string> {
  const convId = await createConv(owner, orgId, agent);
  await postMessage(owner, orgId, convId, callText(params));
  return convId;
}

const approvalRequested = (convId: string) =>
  waitFor(
    async () => ofType(await eventsOf(db, convId), "approval_requested")[0],
    20_000,
    "approval_requested",
  );

const approvalRow = (id: string) =>
  db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const lastResult = async (convId: string) =>
  ofType(await eventsOf(db, convId), "tool_result").at(-1)?.payload;

const approve = (approvalId: string) =>
  owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
    payload: { decision: "approve", scope: "once" },
  });

describe("Platform person fields", () => {
  it("asks on a once-only card holding the field specs and no value", async () => {
    const convId = await probeCall({
      values: { baseUrl: "https://x.example" },
      askPerson: ["apiKey"],
    });
    const asked = await approvalRequested(convId);
    expect(asked.payload.toolKey).toBe(`Platform:${OP}`);
    const row = await approvalRow(asked.payload.approvalId);
    expect(row.scopes).toEqual(["once"]);
    const detail = row.detail as {
      personFields: { path: string; label: string }[];
      target: { zh: string; en: string };
    };
    expect(detail.personFields[0]).toMatchObject({ path: "apiKey", label: "API key" });
    expect(detail.target).toEqual({ zh: "探针配置", en: "Probe config" });
    expect(JSON.stringify(row.input)).not.toContain(SECRET);

    // the approvals view carries the specs
    const list = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/approvals` });
    expect(list.statusCode, list.body).toBe(200);
    const view = (
      list.json() as {
        approvals: { id: string; personFields?: { path: string }[]; personTarget?: unknown }[];
      }
    ).approvals.find((a) => a.id === asked.payload.approvalId);
    expect(view?.personFields?.map((f) => f.path)).toEqual(["apiKey"]);
    expect(view?.personTarget).toEqual({ zh: "探针配置", en: "Probe config" });
  });

  it("runs with the sealed value, and the result names the path, never the value", async () => {
    const convId = await probeCall({ askPerson: ["apiKey"] });
    const asked = await approvalRequested(convId);
    const row = await approvalRow(asked.payload.approvalId);
    await k.app.get(TransactionHost).run(() =>
      k.app.get(SealedInputs).sealIn(
        {
          approvalId: row.id,
          recipientAccountId: ownerId,
          conversationId: convId,
          runId: row.run_id,
          callId: row.call_id,
        },
        { apiKey: SECRET },
      ),
    );
    const before = seen.length;
    const ok = await approve(row.id);
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1, 30_000);
    expect(seen.slice(before)).toEqual([{ paths: ["apiKey"], value: SECRET }]);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("`apiKey`: entered by the person");
    expect(result?.content).not.toContain(SECRET);
    // consumed once, and nowhere else
    expect(
      await db
        .selectFrom("platform_sealed_inputs")
        .selectAll()
        .where("approval_id", "=", row.id)
        .execute(),
    ).toEqual([]);
    const events = await sql<{ payload: unknown }>`
      SELECT payload FROM capybara.conversation_events WHERE conversation_id = ${convId}`.execute(
      db,
    );
    expect(JSON.stringify(events.rows)).not.toContain(SECRET);
    expect(JSON.stringify(await db.selectFrom("approvals").selectAll().execute())).not.toContain(
      SECRET,
    );
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("an approved call whose values are gone returns the expired text and runs nothing", async () => {
    const convId = await probeCall({ askPerson: ["apiKey"] });
    const asked = await approvalRequested(convId);
    const before = seen.length;
    const ok = await approve(asked.payload.approvalId);
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1, 30_000);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(EXPIRED_TEXT);
    expect(seen.slice(before)).toEqual([]);
  });

  it("refuses a secret in values before the card", async () => {
    const convId = await probeCall({ values: { apiKey: "x" } });
    await waitForTerminal(db, convId, 1, 30_000);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(
      "Secret fields are entered by the person on the confirmation card; leave `apiKey` out of values and list it in askPerson. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it.",
    );
  });

  it("asks even under a remembered grant and an allow override (R6)", async () => {
    // the Platform tool's definition fingerprint, from an earlier card
    const first = await approvalRow(
      (await approvalRequested(await probeCall({ askPerson: ["apiKey"] }))).payload.approvalId,
    );
    const allowed = await createAgent("Allowed");
    // an `allow` override on the tool and on the operation's key: the route refuses to save one
    // on a builtin, so it is written into the stored version (as an older version could carry it)
    await sql`UPDATE capybara.agent_versions
      SET definition = jsonb_set(definition, '{toolPolicies}',
        ${JSON.stringify({ Platform: "allow", [`Platform:${OP}`]: "allow" })}::jsonb)
      WHERE agent_id = ${allowed}`.execute(db);
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${orgId}, ${ownerId}, ${allowed}, ${`Platform:${OP}`}, ${first.spec_hash})`.execute(
      db,
    );

    // control: without person fields the grant lets the personal write through
    const before = seen.length;
    const plain = await probeCall({ values: { baseUrl: "https://x.example" } }, allowed);
    await waitForTerminal(db, plain, 1, 30_000);
    expect(ofType(await eventsOf(db, plain), "approval_requested")).toEqual([]);
    expect(seen.slice(before)).toEqual([{ paths: null, value: null }]);

    const convId = await probeCall({ askPerson: ["apiKey"] }, allowed);
    const asked = await approvalRequested(convId);
    expect((await approvalRow(asked.payload.approvalId)).scopes).toEqual(["once"]);
  });

  it("refuses the call in an unattended run (R6)", async () => {
    // a scheduled run's message carries the task header first, so the scripted model answers it
    const scripted = await createAgent("Scripted", { provider: "model-script", model: "script-1" });
    scriptRules([
      { when: { assistantTurns: 1 }, reply: { text: "done" } },
      {
        when: { lastUserIncludes: "probe unattended" },
        reply: {
          toolCalls: [
            {
              name: "Platform",
              input: { action: "call", operation: OP, params: { askPerson: ["apiKey"] } },
            },
          ],
        },
      },
    ]);
    const task = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/schedules`,
      payload: {
        agentId: scripted,
        name: "Probe",
        prompt: "probe unattended",
        mode: "new",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        timeZone: "UTC",
      },
    });
    expect(task.statusCode, task.body).toBe(201);
    const taskId = (task.json() as { task: { id: string } }).task.id;
    const run = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/schedules/${taskId}/run`,
      payload: {},
    });
    expect(run.statusCode, run.body).toBe(202);
    const runId = (run.json() as { run: { id: string } }).run.id;
    const done = await waitFor(
      async () => {
        const r = await db
          .selectFrom("scheduled_task_runs")
          .select(["status", "conversation_id"])
          .where("id", "=", runId)
          .executeTakeFirst();
        return r !== undefined && r.status !== "pending" && r.status !== "running" && r;
      },
      30_000,
      "the task run settled",
    );
    const convId = done.conversation_id as string;
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(UNATTENDED_TEXT);
  });

  it("refuses a call whose ask would go to a role instead of the person (R5)", async () => {
    const convId = await createConv(owner, orgId, agentId);
    escalated.add(convId);
    await postMessage(owner, orgId, convId, callText({ askPerson: ["apiKey"] }));
    await waitForTerminal(db, convId, 1, 30_000);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(R5_TEXT);
  });
});
