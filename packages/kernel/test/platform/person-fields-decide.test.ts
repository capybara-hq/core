import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChannelCardActions, type ChannelCardActionsDeps } from "../../src/channels/actions.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { personFieldParams, secretFieldsOf } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { Waits } from "../../src/runtime/waits.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
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
 * The decision route takes the person's values (platform web parity spec §4.2, §4.3, §4.5, R5,
 * Task 5): an approval with person fields is approved only with every asked value, valid, never
 * seen in the conversation, by its person in a web session (never with a PAT, never from IM); the
 * values are sealed in the decision's transaction and recorded only as paths. A deny works
 * everywhere and takes no values.
 */

const OP = "platform.probe-decide";
const EXPIRED_TEXT =
  "The values the person entered expired before they were applied; call the operation again.";
const LEAKED_TEXT =
  "The person's `apiKey` appeared in the conversation earlier and was refused as leaked; ask them to rotate it.";

/** Every value a test submits: none may appear in a log line, an event or an audit row. */
const VALUES: string[] = [];
const value = (tag: string): string => {
  const v = `sk-${tag}-${randomUUID().slice(0, 8)}-0123456789`;
  VALUES.push(v);
  return v;
};

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string", "x-secret": true, title: "API key", minLength: 12 },
  },
};

/** What the probe's handler saw, per run. */
const seen: { value: string | null }[] = [];

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
  personFields: async () => ({
    target: { zh: "探针配置", en: "Probe config" },
    ...secretFieldsOf(TARGET_SCHEMA, new Set()),
  }),
  run: async (_input, ctx) => {
    const pi = ctx.personInputs;
    if (pi === undefined) return { stored: false };
    const v = await pi.apply(async (values) => values.apiKey ?? null);
    seen.push({ value: v });
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
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE] },
    ),
    { logger: createLogger("debug", { write: (line) => lines.push(line) }) },
  );
  k.app.get(PlatformOperations).register([probe]);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Mine",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const CALL = `tool:Platform:${JSON.stringify({
  action: "call",
  operation: OP,
  params: { askPerson: ["apiKey"] },
})}`;

/** A probe call asking for `apiKey`; `before` is a message posted (and answered) first. */
async function probeCall(before?: string): Promise<{ convId: string; approvalId: string }> {
  const convId = await createConv(owner, orgId, agentId);
  let runs = 0;
  if (before !== undefined) {
    await postMessage(owner, orgId, convId, before);
    await waitForTerminal(db, convId, ++runs, 30_000);
  }
  await postMessage(owner, orgId, convId, CALL);
  const asked = await waitFor(
    async () => ofType(await eventsOf(db, convId), "approval_requested")[0],
    20_000,
    "approval_requested",
  );
  return { convId, approvalId: asked.payload.approvalId };
}

const decide = (
  approvalId: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
) =>
  headers === undefined
    ? owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
        payload,
      })
    : k.http.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
        headers,
        payload,
      });

const approveWith = (approvalId: string, inputs?: Record<string, string>) =>
  decide(approvalId, { decision: "approve", scope: "once", ...(inputs && { inputs }) });

const errorOf = (res: { body: string }) =>
  (JSON.parse(res.body) as { error: { code: string; details?: unknown[] } }).error;

const statusOf = async (id: string) =>
  (await db.selectFrom("approvals").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const lastResult = async (convId: string) =>
  ofType(await eventsOf(db, convId), "tool_result").at(-1)?.payload;

const sealedCount = async () =>
  Number(
    (
      await sql<{ n: string }>`SELECT count(*) AS n FROM capybara.platform_sealed_inputs`.execute(
        db,
      )
    ).rows[0]?.n,
  );

describe("the decision route with person inputs", () => {
  it("approves with the value: the call gets it, the records name the path only", async () => {
    const { convId, approvalId } = await probeCall();
    const secret = value("ok");
    const before = seen.length;
    const ok = await approveWith(approvalId, { apiKey: secret });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).not.toContain(secret);
    await waitForTerminal(db, convId, 1, 30_000);
    // sealed in the decision, consumed by the resumed call
    expect(seen.slice(before)).toEqual([{ value: secret }]);
    expect(await sealedCount()).toBe(0);
    const evs = await eventsOf(db, convId);
    const decided = ofType(evs, "approval_decided")[0];
    expect(decided?.payload).toMatchObject({ decision: "approved", inputsProvided: ["apiKey"] });
    const auditRow = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "approval.decided")
      .where("target", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect((auditRow.detail as { inputsProvided?: string[] }).inputsProvided).toEqual(["apiKey"]);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(false);
    for (const t of ["conversation_events", "audit_events", "approvals"] as const) {
      const rows = await sql`SELECT * FROM ${sql.table(`capybara.${t}`)}`.execute(db);
      expect(JSON.stringify(rows.rows)).not.toContain(secret);
    }
  });

  it("refuses a missing or invalid value with the paths and problems, keeping the card pending", async () => {
    const { approvalId } = await probeCall();
    const missing = await approveWith(approvalId);
    expect(missing.statusCode, missing.body).toBe(422);
    expect(errorOf(missing)).toMatchObject({
      code: "approval.inputs_invalid",
      details: [{ fields: [{ path: "apiKey", problem: "API key is required." }] }],
    });
    const short = "short-value";
    const invalid = await approveWith(approvalId, { apiKey: short });
    expect(invalid.statusCode, invalid.body).toBe(422);
    expect(errorOf(invalid)).toMatchObject({
      code: "approval.inputs_invalid",
      details: [{ fields: [{ path: "apiKey" }] }],
    });
    expect(invalid.body).not.toContain(short);
    expect(await statusOf(approvalId)).toBe("pending");
    expect(await sealedCount()).toBe(0);
  });

  it("refuses an input the approval does not ask for", async () => {
    const { approvalId } = await probeCall();
    const res = await approveWith(approvalId, { apiKey: value("x"), other: value("y") });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("approval.inputs_not_expected");
    expect(await statusOf(approvalId)).toBe("pending");
  });

  it("refuses inputs on an approval without person fields", async () => {
    const plain = await createConv(owner, orgId, agentId);
    // a Platform call without person fields that still asks: a personal operation with no grant
    await postMessage(
      owner,
      orgId,
      plain,
      `tool:Platform:${JSON.stringify({ action: "call", operation: OP, params: {} })}`,
    );
    const asked = await waitFor(
      async () => ofType(await eventsOf(db, plain), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    const res = await approveWith(asked.payload.approvalId, { apiKey: value("np") });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("approval.inputs_not_expected");
  });

  it("refuses a value seen in the conversation, records the path, then takes a fresh one", async () => {
    const leaked = value("leak");
    const { convId, approvalId } = await probeCall(`my key is ${leaked}`);
    const res = await approveWith(approvalId, { apiKey: leaked });
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: "approval.input_leaked",
      details: [{ fields: ["apiKey"] }],
    });
    expect(res.body).not.toContain(leaked);
    const row = await db
      .selectFrom("approvals")
      .select(["status", "detail"])
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect((row.detail as { leakedFields?: string[] }).leakedFields).toEqual(["apiKey"]);
    expect(await sealedCount()).toBe(0);
    // only the leaked paths were committed: no decision event, no decision audit
    expect(ofType(await eventsOf(db, convId), "approval_decided")).toEqual([]);
    expect(
      await db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "approval.decided")
        .where("target", "=", approvalId)
        .execute(),
    ).toEqual([]);
    const fresh = value("fresh");
    const before = seen.length;
    const ok = await approveWith(approvalId, { apiKey: fresh });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 2, 30_000);
    expect(seen.slice(before)).toEqual([{ value: fresh }]);
    expect((await lastResult(convId))?.content).not.toContain(LEAKED_TEXT);
  });

  it("a leak refusal followed by a deny: the result tells the agent to have the key rotated", async () => {
    const leaked = value("leak2");
    const { convId, approvalId } = await probeCall(`here: ${leaked}`);
    const res = await approveWith(approvalId, { apiKey: leaked });
    expect(errorOf(res).code).toBe("approval.input_leaked");
    const no = await decide(approvalId, { decision: "deny" });
    expect(no.statusCode, no.body).toBe(200);
    await waitForTerminal(db, convId, 2, 30_000);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(LEAKED_TEXT);
    expect(result?.content).not.toContain(leaked);
  });

  it("a leak refusal followed by expiry: the result carries the copy", async () => {
    const leaked = value("leak3");
    const { convId, approvalId } = await probeCall(`key: ${leaked}`);
    expect(errorOf(await approveWith(approvalId, { apiKey: leaked })).code).toBe(
      "approval.input_leaked",
    );
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second'
      WHERE id = ${approvalId}`.execute(db);
    await k.app.get(Waits).expire("approval", approvalId);
    expect(await statusOf(approvalId)).toBe("expired");
    await waitForTerminal(db, convId, 2, 30_000);
    const result = await lastResult(convId);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Approval timed out");
    expect(result?.content).toContain(LEAKED_TEXT);
  });

  it("a leak refusal followed by a stop: the cancelled result carries the copy", async () => {
    const leaked = value("leak4");
    const { convId, approvalId } = await probeCall(`key: ${leaked}`);
    expect(errorOf(await approveWith(approvalId, { apiKey: leaked })).code).toBe(
      "approval.input_leaked",
    );
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, convId, 2, 30_000);
    const result = await lastResult(convId);
    expect(result?.content).toContain("The run was stopped while waiting for approval.");
    expect(result?.content).toContain(LEAKED_TEXT);
    expect(result?.content).not.toContain(leaked);
  });

  it("a PAT cannot approve with values but can deny", async () => {
    const pat = await owner({ method: "POST", url: "/api/v1/me/tokens", payload: { name: "cli" } });
    expect(pat.statusCode, pat.body).toBe(201);
    const bearer = { authorization: `Bearer ${(pat.json() as { token: string }).token}` };
    const { approvalId } = await probeCall();
    const yes = await decide(
      approvalId,
      { decision: "approve", inputs: { apiKey: value("pat") } },
      bearer,
    );
    expect(yes.statusCode, yes.body).toBe(403);
    expect(errorOf(yes).code).toBe("auth.session_required");
    expect(await statusOf(approvalId)).toBe("pending");
    const no = await decide(approvalId, { decision: "deny" }, bearer);
    expect(no.statusCode, no.body).toBe(200);
    expect(await statusOf(approvalId)).toBe("denied");
  });

  it("an IM approve is refused with cannotHandle; an IM deny works", async () => {
    const { convId, approvalId } = await probeCall();
    // the card lookup is the channel's (its row needs a connection); everything else is real
    const card = { conversation_id: convId, target: { chatId: "chat", chatType: "dm" } };
    const chain = {
      select: () => chain,
      where: () => chain,
      executeTakeFirst: async () => card,
    };
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
      approvals: k.app.get(ApprovalsService),
      questions: { answer: vi.fn() },
      outbound: { enqueue: vi.fn(async () => undefined) },
      resolveSpeaker: async () => ({ accountId: ownerId, threadAccount: ownerId }),
    } as unknown as ChannelCardActionsDeps);
    const click = (action: "approve" | "deny") =>
      ({
        type: "card_action",
        messageId: "m1",
        sender: { externalId: "u1", tenantId: "t1", locale: "en" },
        target: { chatId: "chat", chatType: "dm" },
        action: { cardKind: "approval", cardId: approvalId, action },
      }) as never;
    await actions.handle("conn1", click("approve"));
    const reply = send.mock.calls[0] as unknown as [string, unknown, { text: string }];
    expect(reply[2].text).toBe("You can't handle this request.");
    expect(await statusOf(approvalId)).toBe("pending");
    await actions.handle("conn1", click("deny"));
    expect(await statusOf(approvalId)).toBe("denied");
  });

  it("two tabs approving with different values: one decision wins, only its value is sealed", async () => {
    const { convId, approvalId } = await probeCall();
    const a = value("tab-a");
    const b = value("tab-b");
    const before = seen.length;
    const [ra, rb] = await Promise.all([
      approveWith(approvalId, { apiKey: a }),
      approveWith(approvalId, { apiKey: b }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(errorOf(loser).code).toBe("approval.already_decided");
    await waitForTerminal(db, convId, 1, 30_000);
    // exactly one sealed row was written and consumed: the winner's value
    expect(seen.slice(before)).toEqual([{ value: ra.statusCode === 200 ? a : b }]);
    expect(await sealedCount()).toBe(0);
  });

  it("values that expire before the resumed call: the expired text, nothing applied; a new call works", async () => {
    // the sealed row is born expired, as if the run waited past the TTL behind a long step
    await sql`CREATE OR REPLACE FUNCTION capybara.test_expire_sealed() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at := now() - interval '1 second'; RETURN NEW; END $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER test_expire_sealed BEFORE INSERT ON capybara.platform_sealed_inputs
      FOR EACH ROW EXECUTE FUNCTION capybara.test_expire_sealed()`.execute(db);
    try {
      const { convId, approvalId } = await probeCall();
      const before = seen.length;
      const ok = await approveWith(approvalId, { apiKey: value("exp") });
      expect(ok.statusCode, ok.body).toBe(200);
      await waitForTerminal(db, convId, 1, 30_000);
      const result = await lastResult(convId);
      expect(result?.isError).toBe(true);
      expect(result?.content).toContain(EXPIRED_TEXT);
      expect(seen.slice(before)).toEqual([]);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_expire_sealed ON capybara.platform_sealed_inputs`.execute(
        db,
      );
    }
    const again = await probeCall();
    const fresh = value("again");
    const before = seen.length;
    const ok = await approveWith(again.approvalId, { apiKey: fresh });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, again.convId, 1, 30_000);
    expect(seen.slice(before)).toEqual([{ value: fresh }]);
  });

  it("decides with inputs on a 5,000-event conversation tree", async () => {
    const { convId, approvalId } = await probeCall();
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
    const ok = await approveWith(approvalId, { apiKey: value("big") });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1, 30_000);
  });

  it("no log line carries a value", () => {
    expect(VALUES.length).toBeGreaterThan(5);
    const all = lines.join("\n");
    for (const v of VALUES) expect(all).not.toContain(v);
  });
});
