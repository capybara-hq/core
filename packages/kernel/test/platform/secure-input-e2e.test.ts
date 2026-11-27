import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { FILE_CHANGED_TEXT, FileRefSchema } from "../../src/platform/file-ref.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { personFieldParams, secretFieldsOf } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { Waits } from "../../src/runtime/waits.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { PERSON_INPUTS_EXPIRED_TEXT } from "../../src/tools/builtins/platform.js";
import {
  APPROVAL_CANCELLED_TEXT,
  leakedOnCardText,
  PERSON_FIELDS_ROLE_TEXT,
  PERSON_FIELDS_UNATTENDED_TEXT,
  PERSON_ONLY_ROLE_TEXT,
  PERSON_ONLY_UNATTENDED_TEXT,
  secureInputCancelledText,
  secureInputExpiredText,
  TOOL_PIPELINE_HOOKS,
  toolReviewDeniedText,
} from "../../src/tools/pipeline.js";
import { createDecidePolicy } from "../../src/tools/policy.js";
import { TOOL_REVIEW_SYSTEM_PROMPT } from "../../src/tools/tool-review.js";
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
 * Secure input through the pipeline and the `Platform` tool (profiles govern every approval, R4,
 * R5, R7): a call with person fields gets its consent from its own policy, grants and the
 * conversation's profile, and then always a `secure_input` request for the values, under every
 * profile. Its values reach only the handler; the result names the request and each entered path.
 * Test-only operations are registered after the start.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const MEM_STORE = fixture("mem-store");
const OP = "platform.secure-probe";
const FILE_OP = "platform.secure-file-probe";
const SECRET = "sk-live-secure-Qx81Lp27Vd";
const CHANGED_TEXT =
  "The target changed after the person confirmed (the fields to enter differ); call the operation again.";

/** Test state: the probe's target also requires a secret `token` (the target changed). */
let tokenRequired = false;
/** What the handlers saw, per run. */
const seen: { op: string; value: unknown; sha256?: string | undefined }[] = [];

const personTarget = () => ({
  target: { zh: "探针配置", en: "Probe config" },
  ...secretFieldsOf(
    {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        apiKey: { type: "string", "x-secret": true, title: "API key" },
        token: { type: "string", "x-secret": true, title: "Token" },
      },
      ...(tokenRequired && { required: ["token"] }),
    },
    new Set(),
  ),
});

const probe = defineOperation({
  id: OP,
  description: "Test only: stores a probe config.",
  input: z.object({
    values: z.record(z.string(), z.unknown()).default({}),
    askPerson: personFieldParams.askPerson,
    clearSecrets: personFieldParams.clearSecrets,
  }),
  example: { values: {}, askPerson: ["apiKey"], clearSecrets: [] },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "personal",
  summary: () => ({ zh: "保存探针配置", en: "Save the probe config" }),
  personFields: async () => personTarget(),
  run: async (input, ctx) => {
    const pi = ctx.personInputs;
    // `baseUrl` picks a misbehaving handler: one that never applies the values, or applies twice
    if (pi !== undefined && input.values.baseUrl === "mode:skip") {
      seen.push({ op: OP, value: "skipped" });
      return { stored: false };
    }
    const value = pi === undefined ? null : await pi.apply(async (v) => v.apiKey ?? null);
    if (pi !== undefined && input.values.baseUrl === "mode:twice") await pi.apply(async () => null);
    seen.push({ op: OP, value });
    return { stored: true };
  },
}) as PlatformOperation;

const fileProbe = defineOperation({
  id: FILE_OP,
  description: "Test only: stores a probe file with a key.",
  input: z
    .object({
      file: FileRefSchema,
      values: z.record(z.string(), z.unknown()).default({}),
      askPerson: personFieldParams.askPerson,
      clearSecrets: personFieldParams.clearSecrets,
    })
    .strict(),
  example: { file: { fileId: randomUUID() }, values: {}, askPerson: ["apiKey"], clearSecrets: [] },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "personal",
  summary: () => ({ zh: "保存探针文件", en: "Store the probe file" }),
  fileRef: (input) => ({ ref: input.file, limits: { maxBytes: 64 * 1024 } }),
  personFields: async () => personTarget(),
  run: async (_input, ctx) => {
    const value = await ctx.personInputs?.apply(async (v) => v.apiKey ?? null);
    seen.push({ op: FILE_OP, value, sha256: ctx.file?.sha256 });
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
/** Every log line the kernel wrote (debug and up). */
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
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, MODEL_SCRIPT, MEM_STORE] },
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
  k.app.get(PlatformOperations).register([probe, fileProbe]);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent("Mine");
  // the review model of Approve for me
  await db
    .insertInto("model_purpose_mappings")
    .values({
      org_id: null,
      purpose: "review",
      provider: "model-script",
      model: "script-2",
      params: "{}",
    })
    .execute();
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
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

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const callText = (operation: string, params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;

/** A new conversation of `agent` on `profile`. */
async function conversation(profile: PermissionProfile, agent = agentId): Promise<string> {
  const convId = await createConv(owner, orgId, agent);
  await db
    .updateTable("conversations")
    .set({ permission_profile: profile, permission_revision: 1 })
    .where("id", "=", convId)
    .execute();
  return convId;
}

/** Posts a probe call in a new conversation on `profile`; returns the conversation id. */
async function probeCall(
  profile: PermissionProfile,
  params: Record<string, unknown> = { askPerson: ["apiKey"] },
  agent = agentId,
): Promise<string> {
  const convId = await conversation(profile, agent);
  await postMessage(owner, orgId, convId, callText(OP, params));
  return convId;
}

const approvalsOf = (convId: string) =>
  db
    .selectFrom("approvals")
    .selectAll()
    .where("conversation_id", "=", convId)
    .orderBy("attempt")
    .execute();

/** The call's pending approval of `kind`, once written. */
const pending = (convId: string, kind: "tool" | "secure_input") =>
  waitFor(
    async () => (await approvalsOf(convId)).find((a) => a.kind === kind && a.status === "pending"),
    20_000,
    `a pending ${kind} approval`,
  );

const decide = (approvalId: string, payload: Record<string, unknown>) =>
  owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
    payload,
  });

const submit = (approvalId: string, inputs: Record<string, string> = { apiKey: SECRET }) =>
  decide(approvalId, { decision: "approve", inputs });

const lastResult = async (convId: string) =>
  ofType(await eventsOf(db, convId), "tool_result").at(-1)?.payload;

const decisionsOf = async (convId: string) =>
  ofType(await eventsOf(db, convId), "tool_ask_decided").map((e) => e.payload);

const settled = (convId: string) => waitForTerminal(db, convId, 1, 30_000);

/** The value is in no event, approval, audit row or log line. */
async function foundNowhere(value: string) {
  const events = await sql<{ payload: unknown }>`
    SELECT payload FROM capybara.conversation_events`.execute(db);
  expect(JSON.stringify(events.rows)).not.toContain(value);
  expect(JSON.stringify(await db.selectFrom("approvals").selectAll().execute())).not.toContain(
    value,
  );
  expect(JSON.stringify(await db.selectFrom("audit_events").selectAll().execute())).not.toContain(
    value,
  );
  expect(lines.join("\n")).not.toContain(value);
}

/**
 * Runs `fn` while the decision's seal writes nothing (a trigger drops the insert): the submitted
 * request then has no sealed row.
 */
async function withSealDropped<T>(fn: () => Promise<T>): Promise<T> {
  await sql`CREATE OR REPLACE FUNCTION capybara.test_drop_sealed() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(db);
  await sql`CREATE TRIGGER test_drop_sealed BEFORE INSERT ON capybara.platform_sealed_inputs
    FOR EACH ROW EXECUTE FUNCTION capybara.test_drop_sealed()`.execute(db);
  try {
    return await fn();
  } finally {
    await sql`DROP TRIGGER IF EXISTS test_drop_sealed ON capybara.platform_sealed_inputs`.execute(
      db,
    );
  }
}

/** Runs an automation (unattended) whose scripted model makes one Platform call; its events. */
async function unattendedCall(
  prompt: string,
  operation = OP,
  params: Record<string, unknown> = { askPerson: ["apiKey"] },
): Promise<ConversationEvent[]> {
  const scripted = await createAgent("Scripted", { provider: "model-script", model: "script-1" });
  scriptRules([
    { when: { assistantTurns: 1 }, reply: { text: "done" } },
    {
      when: { lastUserIncludes: prompt },
      reply: {
        toolCalls: [
          {
            name: "Platform",
            input: { action: "call", operation, params },
          },
        ],
      },
    },
  ]);
  const task = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/automations`,
    payload: {
      agentId: scripted,
      name: "Probe",
      prompt,
      mode: "new",
      trigger: { kind: "cron", expr: "0 9 * * *" },
      timeZone: "UTC",
    },
  });
  expect(task.statusCode, task.body).toBe(201);
  const taskId = (task.json() as { task: { id: string } }).task.id;
  const run = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/automations/${taskId}/run`,
    payload: {},
  });
  expect(run.statusCode, run.body).toBe(202);
  const runId = (run.json() as { run: { id: string } }).run.id;
  const done = await waitFor(
    async () => {
      const r = await db
        .selectFrom("automation_runs")
        .select(["status", "conversation_id"])
        .where("id", "=", runId)
        .executeTakeFirst();
      return r !== undefined && r.status !== "pending" && r.status !== "running" && r;
    },
    30_000,
    "the task run settled",
  );
  return eventsOf(db, done.conversation_id as string);
}

/** A ready `chat` attachment of `conv`; returns its id and object key. */
async function attachment(conv: string, bytes: Uint8Array) {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  await k.app.get(StorageService).kernel(orgId).put(objectKey, bytes, {
    contentType: "text/plain",
    size: bytes.byteLength,
  });
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: ownerId,
      name: "notes.txt",
      content_type: "text/plain",
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      etag: null,
      purpose: "chat",
    })
    .execute();
  return { id, objectKey };
}

describe("secure input under each profile", () => {
  it("Request approval: the tool approval first, then the secure input; Submit applies the value", async () => {
    const before = seen.length;
    const convId = await probeCall("request-approval");
    const consent = await pending(convId, "tool");
    // the consent carries no field: it follows the call's policy (remembered for a personal op)
    expect(consent.detail).toBeNull();
    expect(consent.scopes).toBeNull();
    expect(await approvalsOf(convId)).toHaveLength(1);
    expect((await decide(consent.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);

    const si = await pending(convId, "secure_input");
    expect(si).toMatchObject({ requested_for: ownerId, scopes: ["once"], attempt: 2 });
    expect((si.detail as { personFields: { path: string }[] }).personFields).toEqual([
      expect.objectContaining({ path: "apiKey" }),
    ]);
    expect(seen.slice(before)).toEqual([]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);

    expect(seen.slice(before)).toEqual([{ op: OP, value: SECRET }]);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain(
      `Secure input ${si.id}: submitted.\n\`apiKey\`: entered by the person`,
    );
    expect(result?.content).not.toContain(SECRET);
    await foundNowhere(SECRET);
  });

  it("Auto: no tool approval; the secure input at once, and Submit runs the call", async () => {
    const before = seen.length;
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    expect(si.attempt).toBe(1);
    expect((await approvalsOf(convId)).filter((a) => a.kind === "tool")).toEqual([]);
    expect(await decisionsOf(convId)).toEqual([
      expect.objectContaining({ outcome: "allow", decisionSource: "full-access" }),
    ]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    expect(seen.slice(before)).toEqual([{ op: OP, value: SECRET }]);
    // the resumed call reused the recorded decision: one event for the call
    expect(await decisionsOf(convId)).toHaveLength(1);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain(`Secure input ${si.id}: submitted.`);
    expect(result?.content).not.toContain(SECRET);
    await foundNowhere(SECRET);
  });

  it("Approve for me with an allow: the review decides, then the secure input as under Auto", async () => {
    scriptRules([
      {
        when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT },
        reply: { text: JSON.stringify({ decision: "allow", reason: "The person asked." }) },
      },
    ]);
    const before = seen.length;
    const convId = await probeCall("approve-for-me");
    const si = await pending(convId, "secure_input");
    expect((await approvalsOf(convId)).filter((a) => a.kind === "tool")).toEqual([]);
    expect(await decisionsOf(convId)).toEqual([
      expect.objectContaining({ outcome: "allow", decisionSource: "review-model" }),
    ]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    expect(seen.slice(before)).toEqual([{ op: OP, value: SECRET }]);
    expect((await lastResult(convId))?.isError).toBe(false);
    expect(await decisionsOf(convId)).toHaveLength(1);
    scriptRules([]);
  });

  it("Approve for me with a deny: the deny text, and no secure input is raised", async () => {
    scriptRules([
      {
        when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT },
        reply: { text: JSON.stringify({ decision: "deny", reason: "Not asked for." }) },
      },
    ]);
    const before = seen.length;
    const convId = await probeCall("approve-for-me");
    await settled(convId);
    scriptRules([]);
    expect(await approvalsOf(convId)).toEqual([]);
    expect(await decisionsOf(convId)).toEqual([
      expect.objectContaining({ outcome: "deny", decisionSource: "review-model" }),
    ]);
    expect(await lastResult(convId)).toMatchObject({
      isError: true,
      content: toolReviewDeniedText("Not asked for."),
    });
    expect(seen.slice(before)).toEqual([]);
  });

  it("an agent's allow override lifts neither the consent nor the secure input", async () => {
    const allowed = await createAgent("Allowed");
    // the route refuses to save an override on a builtin, so it is written into the stored version
    await sql`UPDATE capybara.agent_versions
      SET definition = jsonb_set(definition, '{toolPolicies}',
        ${JSON.stringify({ Platform: "allow", [`Platform:${OP}`]: "allow" })}::jsonb)
      WHERE agent_id = ${allowed}`.execute(db);
    const before = seen.length;
    const convId = await probeCall("request-approval", { askPerson: ["apiKey"] }, allowed);
    // an agent override only tightens: the consent is still asked
    const consent = await pending(convId, "tool");
    expect((await decide(consent.id, { decision: "approve", scope: "once" })).statusCode).toBe(200);
    const si = await pending(convId, "secure_input");
    expect(seen.slice(before)).toEqual([]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    expect(seen.slice(before)).toEqual([{ op: OP, value: SECRET }]);
  });

  it("a remembered grant skips the consent, never the secure input", async () => {
    // the Platform tool's definition fingerprint, from an earlier request
    const earlier = await pending(await probeCall("full-access"), "secure_input");
    const granted = await createAgent("Granted");
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${orgId}, ${ownerId}, ${granted}, ${`Platform:${OP}`}, ${earlier.spec_hash})`.execute(
      db,
    );
    const before = seen.length;
    const convId = await probeCall("request-approval", { askPerson: ["apiKey"] }, granted);
    const si = await pending(convId, "secure_input");
    expect((await approvalsOf(convId)).map((a) => a.kind)).toEqual(["secure_input"]);
    expect(await decisionsOf(convId)).toEqual([]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    expect(seen.slice(before)).toEqual([{ op: OP, value: SECRET }]);
  });
});

describe("secure input outcomes", () => {
  it("Cancel ends the call with the cancelled text; nothing applied", async () => {
    const before = seen.length;
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    expect((await decide(si.id, { decision: "deny" })).statusCode).toBe(200);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true, content: secureInputCancelledText(si.id) });
    expect(seen.slice(before)).toEqual([]);
  });

  it("an expired request ends the call with the expired text; nothing applied", async () => {
    const before = seen.length;
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    await sql`UPDATE capybara.approvals SET expires_at = now(), created_at = now() - interval '24 hours'
      WHERE id = ${si.id}`.execute(db);
    await k.app.get(Waits).expire("approval", si.id);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true, content: secureInputExpiredText(si.id, 24) });
    expect(seen.slice(before)).toEqual([]);
  });

  it("a run stopped while the request waits ends the call with the cancelled approval text", async () => {
    const convId = await probeCall("full-access");
    await pending(convId, "secure_input");
    const abort = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(abort.statusCode, abort.body).toBe(202);
    await settled(convId);
    expect((await lastResult(convId))?.content).toContain(APPROVAL_CANCELLED_TEXT);
  });

  it("refuses the call in an unattended run before any request", async () => {
    const evs = await unattendedCall("secure probe unattended");
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(PERSON_FIELDS_UNATTENDED_TEXT);
  });

  it("refuses a call whose ask would go to a role before any request", async () => {
    const convId = await conversation("full-access");
    escalated.add(convId);
    await postMessage(owner, orgId, convId, callText(OP, { askPerson: ["apiKey"] }));
    await settled(convId);
    expect(await approvalsOf(convId)).toEqual([]);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(PERSON_FIELDS_ROLE_TEXT);
  });

  it("asked fields that changed between the request and the run: the changed text, nothing applied", async () => {
    const before = seen.length;
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    // the target now also requires `token`, which the request never asked for
    tokenRequired = true;
    try {
      expect((await submit(si.id)).statusCode).toBe(200);
      await settled(convId);
    } finally {
      tokenRequired = false;
    }
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(CHANGED_TEXT);
    expect(seen.slice(before)).toEqual([]);
  });
});

describe("secure input values", () => {
  it("refuses a secret in values before any request", async () => {
    const convId = await probeCall("full-access", { values: { apiKey: "x" } });
    await settled(convId);
    expect(await approvalsOf(convId)).toEqual([]);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(
      "Secret fields are entered by the person in a secure input request; leave `apiKey` out of values and list it in askPerson. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it.",
    );
  });

  it("a submitted request whose values are gone returns the expired text; nothing applied", async () => {
    const before = seen.length;
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    expect((await withSealDropped(() => submit(si.id))).statusCode).toBe(200);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(PERSON_INPUTS_EXPIRED_TEXT);
    expect(seen.slice(before)).toEqual([]);
  });

  it("a handler that never applies the values says so, without the entered line", async () => {
    const convId = await probeCall("full-access", {
      values: { baseUrl: "mode:skip" },
      askPerson: ["apiKey"],
    });
    const si = await pending(convId, "secure_input");
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain(`Secure input ${si.id}: submitted.`);
    expect(result?.content).toContain(`The values the person entered were not used by ${OP}.`);
    expect(result?.content).not.toContain("entered by the person`");
  });
});

describe("leaked values", () => {
  const LEAKED_TEXT = leakedOnCardText("apiKey");

  /**
   * A conversation on Auto where the person first posted `leaked`, then the probe call; the person
   * submits the leaked value, which is refused. Returns the conversation and the request.
   */
  async function leakedRequest(leaked: string) {
    const convId = await conversation("full-access");
    await postMessage(owner, orgId, convId, `my key is ${leaked}`);
    await waitForTerminal(db, convId, 1, 30_000);
    await postMessage(owner, orgId, convId, callText(OP, { askPerson: ["apiKey"] }));
    const si = await pending(convId, "secure_input");
    const res = await submit(si.id, { apiKey: leaked });
    expect(res.statusCode, res.body).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "approval.input_leaked" } });
    expect(res.body).not.toContain(leaked);
    return { convId, si };
  }

  it("a leak refusal followed by Cancel: the result tells the agent to have the key rotated", async () => {
    const leaked = "sk-leak-cancel-Ru27Ma44";
    const { convId, si } = await leakedRequest(leaked);
    expect((await decide(si.id, { decision: "deny" })).statusCode).toBe(200);
    await waitForTerminal(db, convId, 2, 30_000);
    const result = await lastResult(convId);
    expect(result).toMatchObject({
      isError: true,
      content: `${secureInputCancelledText(si.id)}\n${LEAKED_TEXT}`,
    });
    expect(result?.content).not.toContain(leaked);
  });

  it("a leak refusal followed by expiry: the result carries the copy", async () => {
    const { convId, si } = await leakedRequest("sk-leak-expire-Bt63Wn18");
    await sql`UPDATE capybara.approvals SET expires_at = now(), created_at = now() - interval '24 hours'
      WHERE id = ${si.id}`.execute(db);
    await k.app.get(Waits).expire("approval", si.id);
    await waitForTerminal(db, convId, 2, 30_000);
    expect(await lastResult(convId)).toMatchObject({
      isError: true,
      content: `${secureInputExpiredText(si.id, 24)}\n${LEAKED_TEXT}`,
    });
  });

  it("a leak refusal followed by a stop: the cancelled result carries the copy", async () => {
    const leaked = "sk-leak-stop-Hc90Ze35";
    const { convId } = await leakedRequest(leaked);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId, 2, 30_000);
    const result = await lastResult(convId);
    expect(result?.content).toContain(APPROVAL_CANCELLED_TEXT);
    expect(result?.content).toContain(LEAKED_TEXT);
    expect(result?.content).not.toContain(leaked);
  });

  it("a second apply is a programming error, not the expired text", async () => {
    const convId = await probeCall("full-access", {
      values: { baseUrl: "mode:twice" },
      askPerson: ["apiKey"],
    });
    const si = await pending(convId, "secure_input");
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain(PERSON_INPUTS_EXPIRED_TEXT);
    expect(result?.content).not.toContain(SECRET);
    expect(lines.join("\n")).toContain("personInputs.apply called twice");
  });

  it("submits with values on a 5,000-event conversation tree", async () => {
    const convId = await probeCall("full-access");
    const si = await pending(convId, "secure_input");
    // the events go into a sub-agent conversation of the tree: the leak check reads the whole
    // tree, and the waiting run's own log stays as it is
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        source: "web",
        kind: "subagent",
        parent_conversation_id: convId,
      })
      .execute();
    await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload)
      SELECT ${child}, g, 'tool_result',
        jsonb_build_object('type', 'tool_result', 'output', repeat('lorem ipsum ', 80) || g)
      FROM generate_series(1, 5000) g`.execute(db);
    expect((await submit(si.id, { apiKey: "sk-big-tree-Pq52Ld09" })).statusCode).toBe(200);
    await settled(convId);
    expect((await lastResult(convId))?.isError).toBe(false);
  });
});

describe("results shown once to the run's person", () => {
  it("are refused in an unattended run", async () => {
    const evs = await unattendedCall("secure invite unattended", "orgs.invite", {
      role: "member",
    });
    expect(ofType(evs, "approval_requested")).toEqual([]);
    expect(ofType(evs, "tool_result").at(-1)?.payload.content).toContain(
      PERSON_ONLY_UNATTENDED_TEXT,
    );
    expect(await db.selectFrom("invitations").select("id").execute()).toEqual([]);
  });

  it("are refused when the ask would go to a role", async () => {
    const convId = await conversation("full-access");
    escalated.add(convId);
    await postMessage(owner, orgId, convId, callText("orgs.invite", { role: "member" }));
    await settled(convId);
    expect(await approvalsOf(convId)).toEqual([]);
    expect((await lastResult(convId))?.content).toContain(PERSON_ONLY_ROLE_TEXT);
  });
});

describe("file references without an approval (R7)", () => {
  const filePrompt = (fileId: string) =>
    callText(FILE_OP, { file: { fileId }, askPerson: ["apiKey"] });

  it("Auto runs when the bytes still match the decision's sha256", async () => {
    const convId = await conversation("full-access");
    const bytes = new TextEncoder().encode("hello, bytes A\n");
    const { id } = await attachment(convId, bytes);
    const before = seen.length;
    await postMessage(owner, orgId, convId, filePrompt(id));
    const si = await pending(convId, "secure_input");
    expect(await decisionsOf(convId)).toEqual([
      expect.objectContaining({ decisionSource: "full-access", fileSha256: sha256(bytes) }),
    ]);
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    expect((await lastResult(convId))?.isError).toBe(false);
    expect(seen.slice(before)).toEqual([{ op: FILE_OP, value: SECRET, sha256: sha256(bytes) }]);
  });

  it("Auto refuses bytes that changed after the decision", async () => {
    const convId = await conversation("full-access");
    const bytes = new TextEncoder().encode("hello, bytes A\n");
    const { id, objectKey } = await attachment(convId, bytes);
    const before = seen.length;
    await postMessage(owner, orgId, convId, filePrompt(id));
    const si = await pending(convId, "secure_input");
    // same size, other bytes
    const changed = new TextEncoder().encode("hello, bytes B\n");
    await k.app.get(StorageService).kernel(orgId).put(objectKey, changed, {
      contentType: "text/plain",
      size: changed.byteLength,
    });
    expect((await submit(si.id)).statusCode).toBe(200);
    await settled(convId);
    const result = await lastResult(convId);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain(FILE_CHANGED_TEXT);
    expect(seen.slice(before)).toEqual([]);
  });
});
