import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelCardActions, type ChannelCardActionsDeps } from "../../src/channels/actions.js";
import { personFieldsCard } from "../../src/channels/cards.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { PersonFieldSpec } from "../../src/platform/person-fields.js";
import { type ApprovalRecord, ApprovalsService } from "../../src/tools/approvals.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { eventsOf, PW, runConfig, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Secure input requests (profiles govern every approval, ruling R4): an approval of kind
 * `secure_input` asking the run's person for a call's secret fields. Submit is a decision `approve`
 * with `inputs` (every asked value, valid, never seen in the conversation, by its person in a web
 * session, never a PAT or IM); Cancel is `deny`. The values are sealed in the decision's
 * transaction and recorded only as paths.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accounts: AccountsService;
let members: MembersService;
const lines: string[] = [];

type Req = ReturnType<typeof asUser>;

let owner: Account;
let orgId: string;
let person: { account: Account; req: Req };
let admin: { account: Account; req: Req };
let other: { account: Account; req: Req };
let conversationId: string;
let runId: string;

/** Every value a test submits: none may appear in a record or a log line. */
const VALUES: string[] = [];
const value = (tag: string): string => {
  const v = `sk-${tag}-${randomUUID().slice(0, 8)}-0123456789`;
  VALUES.push(v);
  return v;
};

const FIELDS: PersonFieldSpec[] = [
  {
    path: "apiKey",
    label: { zh: "API 密钥", en: "API key" },
    multiline: false,
    required: true,
    isSet: false,
    schema: { type: "string", minLength: 12 },
  } as PersonFieldSpec,
];
const TARGET = { zh: "探针配置", en: "Probe config" };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }), {
    env: {},
    logger: createLogger("debug", { write: (line) => lines.push(line) }),
  });
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
  accounts = accountsFor(db);
  members = testMembers(db);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function login(loginName: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: loginName, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function member(loginName: string, role: "admin" | "member") {
  const account = await accounts.createLocal({
    login: loginName,
    password: PW,
    displayName: loginName,
  });
  await members.add(orgId, account.id, role, owner.id);
  return { account, req: await login(loginName) };
}

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const o = await login("owner");
  const res = await o({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  orgId = (res.json() as { org: { id: string } }).org.id;
  person = await member("per", "member");
  admin = await member("adm", "admin");
  other = await member("oth", "member");
  const agentId = randomUUID();
  conversationId = randomUUID();
  runId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${person.account.id}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${agentId}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${person.account.id})`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${person.account.id})`.execute(raw);
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${runId}, ${conversationId}, 'running', 1, ${person.account.id}, 0)`.execute(raw);
});

const svc = () => k.app.get(ApprovalsService);

function requestSecureInput(
  over: { callId?: string; attempt?: number; fields?: PersonFieldSpec[] } = {},
): Promise<ApprovalRecord> {
  return svc().requestSecureInput({
    attempt: over.attempt ?? 1,
    orgId,
    conversationId,
    runId,
    step: 1,
    callId: over.callId ?? `c-${randomUUID().slice(0, 8)}`,
    toolKey: "Platform:platform.probe",
    specHash: "hash-1",
    connectorId: null,
    input: { action: "call", operation: "platform.probe", params: { askPerson: ["apiKey"] } },
    requestedFor: person.account.id,
    target: TARGET,
    personFields: over.fields ?? FIELDS,
  });
}

const base = () => `/api/v1/orgs/${orgId}/approvals`;
const decide = (req: Req, id: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `${base()}/${id}/decision`, payload });
const submit = (id: string, inputs?: Record<string, string>, req: Req = person.req) =>
  decide(req, id, { decision: "approve", ...(inputs && { inputs }) });
const errorOf = (res: { body: string }) =>
  (JSON.parse(res.body) as { error: { code: string; details?: unknown[] } }).error;
const statusOf = async (id: string) =>
  (await db.selectFrom("approvals").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;
const sealedFor = async (id: string) =>
  db
    .selectFrom("platform_sealed_inputs")
    .select(["approval_id", "paths", "recipient_account_id"])
    .where("approval_id", "=", id)
    .execute();

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

describe("requesting a secure input", () => {
  it("stores a secure_input approval and its display-only approval_requested", async () => {
    const a = await requestSecureInput();
    expect(a).toMatchObject({
      kind: "secure_input",
      status: "pending",
      scopes: ["once"],
      requestedFor: person.account.id,
      approverRole: null,
      personFields: FIELDS,
      personTarget: TARGET,
    });
    const asked = ofType(await eventsOf(db, conversationId), "approval_requested");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject({
      approvalId: a.id,
      callId: a.callId,
      toolKey: "Platform:platform.probe",
      secureInput: { target: TARGET, fields: ["apiKey"] },
      requestedFor: person.account.id,
      approverRole: null,
    });
    // the call's input is shown nowhere: not in the event, not in the view
    expect(JSON.stringify(asked[0]?.payload)).not.toContain("askPerson");
    const view = await person.req({ method: "GET", url: `${base()}/${a.id}` });
    expect(view.statusCode, view.body).toBe(200);
    const v = (view.json() as { approval: Record<string, unknown> }).approval;
    expect(v).toMatchObject({
      kind: "secure_input",
      personFields: FIELDS,
      personTarget: TARGET,
      scopes: ["once"],
    });
    expect(JSON.stringify(v)).not.toContain("askPerson");
    // listed (and so in the inbox feed) for the person
    const list = await person.req({ method: "GET", url: `${base()}?status=pending` });
    expect((list.json() as { approvals: { id: string }[] }).approvals.map((x) => x.id)).toEqual([
      a.id,
    ]);
  });

  it("is idempotent per attempt; secureInputForCall returns the latest attempt", async () => {
    const callId = "c-idem";
    const first = await requestSecureInput({ callId });
    const again = await requestSecureInput({ callId });
    expect(again.id).toBe(first.id);
    expect(ofType(await eventsOf(db, conversationId), "approval_requested")).toHaveLength(1);
    // a tool approval of the same call is not a secure input
    await svc().request({
      orgId,
      conversationId,
      runId,
      step: 1,
      callId,
      attempt: 3,
      toolKey: "Platform:platform.probe",
      specHash: "hash-1",
      connectorId: null,
      input: {},
      requestedFor: person.account.id,
      approverRole: null,
    });
    const second = await requestSecureInput({ callId, attempt: 2 });
    expect((await svc().secureInputForCall(runId, callId))?.id).toBe(second.id);
    expect(await svc().secureInputForCall(runId, "c-none")).toBeNull();
    // an attempt another kind already holds is never returned as a secure input
    await expect(requestSecureInput({ callId, attempt: 3 })).rejects.toThrow();
  });

  it("refuses no fields or more than 32", async () => {
    await expect(requestSecureInput({ fields: [] })).rejects.toThrow();
    const many = Array.from({ length: 33 }, (_, i) => ({ ...FIELDS[0], path: `f${i}` }));
    await expect(requestSecureInput({ fields: many as PersonFieldSpec[] })).rejects.toThrow();
  });
});

describe("submitting and cancelling a secure input", () => {
  it("submits the value: sealed under the request's id, the records name the path only", async () => {
    const a = await requestSecureInput();
    const secret = value("ok");
    const ok = await submit(a.id, { apiKey: secret });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).not.toContain(secret);
    expect(await statusOf(a.id)).toBe("approved");
    expect(await sealedFor(a.id)).toEqual([
      { approval_id: a.id, paths: ["apiKey"], recipient_account_id: person.account.id },
    ]);
    const decided = ofType(await eventsOf(db, conversationId), "approval_decided");
    expect(decided[0]?.payload).toMatchObject({
      approvalId: a.id,
      decision: "approved",
      scope: "once",
      inputsProvided: ["apiKey"],
    });
    const auditRow = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "approval.decided")
      .where("target", "=", a.id)
      .executeTakeFirstOrThrow();
    expect(auditRow.detail).toMatchObject({ kind: "secure_input", inputsProvided: ["apiKey"] });
    for (const t of ["conversation_events", "audit_events", "approvals"] as const) {
      const rows = await sql`SELECT * FROM ${sql.table(`capybara.${t}`)}`.execute(db);
      expect(JSON.stringify(rows.rows)).not.toContain(secret);
    }
  });

  it("refuses a missing value and an undeclared path, keeping the request pending", async () => {
    const a = await requestSecureInput();
    const missing = await submit(a.id);
    expect(missing.statusCode, missing.body).toBe(422);
    expect(errorOf(missing)).toMatchObject({
      code: "approval.inputs_invalid",
      details: [{ fields: [{ path: "apiKey", problem: "API key is required." }] }],
    });
    const extra = await submit(a.id, { apiKey: value("x"), other: value("y") });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(errorOf(extra).code).toBe("approval.inputs_not_expected");
    expect(await statusOf(a.id)).toBe("pending");
    expect(await sealedFor(a.id)).toEqual([]);
  });

  it("refuses a value seen in the conversation, records the path, then takes a fresh one", async () => {
    const leaked = value("leak");
    await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload)
      VALUES (${conversationId}, 1000, 'user_message',
        ${JSON.stringify({ text: `my key is ${leaked}` })}::jsonb)`.execute(raw);
    const a = await requestSecureInput();
    const res = await submit(a.id, { apiKey: leaked });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: "approval.input_leaked",
      details: [{ fields: ["apiKey"] }],
    });
    expect(res.body).not.toContain(leaked);
    expect(await statusOf(a.id)).toBe("pending");
    expect(await sealedFor(a.id)).toEqual([]);
    const view = await person.req({ method: "GET", url: `${base()}/${a.id}` });
    expect(
      (view.json() as { approval: { leakedFields?: string[] } }).approval.leakedFields,
    ).toEqual(["apiKey"]);
    const ok = await submit(a.id, { apiKey: value("fresh") });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await sealedFor(a.id)).toHaveLength(1);
  });

  it("a PAT cannot submit but can cancel", async () => {
    const pat = await person.req({
      method: "POST",
      url: "/api/v1/me/tokens",
      payload: { name: "cli" },
    });
    expect(pat.statusCode, pat.body).toBe(201);
    const headers = { authorization: `Bearer ${(pat.json() as { token: string }).token}` };
    const a = await requestSecureInput();
    const yes = await k.http.inject({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      headers,
      payload: { decision: "approve", inputs: { apiKey: value("pat") } },
    });
    expect(yes.statusCode, yes.body).toBe(403);
    expect(errorOf(yes).code).toBe("auth.session_required");
    expect(await statusOf(a.id)).toBe("pending");
    const no = await k.http.inject({
      method: "POST",
      url: `${base()}/${a.id}/decision`,
      headers,
      payload: { decision: "deny" },
    });
    expect(no.statusCode, no.body).toBe(200);
    expect(await statusOf(a.id)).toBe("denied");
    expect(await sealedFor(a.id)).toEqual([]);
  });

  it("two concurrent submits with different values: one wins, exactly one sealed row", async () => {
    const a = await requestSecureInput();
    const [ra, rb] = await Promise.all([
      submit(a.id, { apiKey: value("tab-a") }),
      submit(a.id, { apiKey: value("tab-b") }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(errorOf(loser).code).toBe("approval.already_decided");
    expect(await sealedFor(a.id)).toHaveLength(1);
  });

  it("another member, even an org admin, can neither see nor decide it", async () => {
    const a = await requestSecureInput();
    for (const u of [admin, other]) {
      const one = await u.req({ method: "GET", url: `${base()}/${a.id}` });
      expect(one.statusCode).toBe(404);
      const list = await u.req({ method: "GET", url: base() });
      expect((list.json() as { approvals: unknown[] }).approvals).toEqual([]);
      const res = await submit(a.id, { apiKey: value("someone") }, u.req);
      expect(res.statusCode, res.body).toBe(404);
      expect(errorOf(res).code).toBe("approval.not_found");
      const cancel = await decide(u.req, a.id, { decision: "deny" });
      expect(cancel.statusCode, cancel.body).toBe(404);
    }
    expect(await statusOf(a.id)).toBe("pending");
  });

  it("a tool approval without person fields still refuses inputs", async () => {
    const t = await svc().request({
      orgId,
      conversationId,
      runId,
      step: 1,
      callId: "c-tool",
      toolKey: "Platform:platform.probe",
      specHash: "hash-1",
      connectorId: null,
      input: {},
      requestedFor: person.account.id,
      approverRole: null,
    });
    const res = await submit(t.id, { apiKey: value("np") });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("approval.inputs_not_expected");
  });
});

describe("secure input in IM", () => {
  const imActions = (cardConv: string) => {
    const card = { conversation_id: cardConv, target: { chatId: "chat", chatType: "dm" } };
    const chain = { select: () => chain, where: () => chain, executeTakeFirst: async () => card };
    const imDb = new Proxy(db, {
      get(target, p, receiver) {
        if (p === "selectFrom") {
          return (table: string) =>
            table === "channel_card_messages"
              ? chain
              : (target.selectFrom as (t: string) => unknown)(table);
        }
        return Reflect.get(target, p, receiver);
      },
    });
    const send = vi.fn(async () => ({ messageId: "m2" }));
    const actions = new ChannelCardActions({
      db: imDb,
      connections: {
        row: async () => ({ id: "conn1", orgId, status: "active", pluginEnabled: true }),
        send,
      },
      approvals: svc(),
      questions: { answer: vi.fn() },
      outbound: { enqueue: vi.fn(async () => undefined) },
      resolveSpeaker: async () => ({
        accountId: person.account.id,
        threadAccount: person.account.id,
      }),
    } as unknown as ChannelCardActionsDeps);
    return { actions, send };
  };
  const click = (id: string, action: "approve" | "deny") =>
    ({
      type: "card_action",
      messageId: "m1",
      sender: { externalId: "u1", tenantId: "t1", locale: "en" },
      target: { chatId: "chat", chatType: "dm" },
      action: { cardKind: "approval", cardId: id, action },
    }) as never;

  it("a card action is refused with cannotHandle, whatever it asks", async () => {
    const a = await requestSecureInput();
    const { actions, send } = imActions(conversationId);
    for (const action of ["approve", "deny"] as const) {
      send.mockClear();
      await actions.handle("conn1", click(a.id, action));
      const reply = send.mock.calls[0] as unknown as [string, unknown, { text: string }];
      expect(reply[2].text).toBe("You can't handle this request.");
      expect(await statusOf(a.id)).toBe("pending");
    }
  });

  it("the IM card is the web-only bind card", async () => {
    const a = await requestSecureInput();
    const d = { db, approvals: svc() } as never;
    expect(await personFieldsCard(d, a.id, "https://cap.example", "zh")).toEqual({
      kind: "bind",
      text: "需要在网页填写 1 项",
      url: `https://cap.example/chat/${conversationId}`,
    });
  });
});

describe("the kind check", () => {
  it("accepts secure_input and still rejects an unknown kind", async () => {
    const insert = (kind: string) =>
      sql`INSERT INTO capybara.approvals (id, org_id, conversation_id, run_id, call_id, attempt,
          kind, tool_key, spec_hash, input, requested_for, expires_at)
        VALUES (${randomUUID()}, ${orgId}, ${conversationId}, ${runId}, ${randomUUID()}, 1,
          ${kind}, 'X', 'h', '{}'::jsonb, ${person.account.id}, now() + interval '1 hour')`.execute(
        raw,
      );
    await expect(insert("secure_input")).resolves.toBeDefined();
    await expect(insert("bogus")).rejects.toThrow(/approvals_kind_check/);
  });
});

describe("logs", () => {
  it("no log line carries a value", () => {
    expect(VALUES.length).toBeGreaterThan(5);
    const all = lines.join("\n");
    for (const v of VALUES) expect(all).not.toContain(v);
  });
});
