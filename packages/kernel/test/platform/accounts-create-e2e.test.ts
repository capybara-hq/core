import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { InitialPasswordCleanupJob } from "../../src/identity/initial-passwords.job.js";
import {
  deleteExpiredInitialPasswords,
  InitialPasswords,
} from "../../src/identity/initial-passwords.js";
import { createLogger } from "../../src/log.js";
import { INITIAL_PASSWORD_NOTE } from "../../src/platform/ops/accounts.ops.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
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
 * `accounts.create` end to end (Platform tool spec §14.5 item 2, Review Focus 4): the super admin's
 * private agent creates an account; the kernel generates the password, the approver reads it once
 * on the web, and it appears nowhere else: not in the tool result, the conversation events, the
 * approval rows, the audit, or any log line. The new account must change it before anything else.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: Req;
let rootId: string;
let other: Req;
let orgId: string;
let agentId: string;
/** Every log line the kernel wrote (debug and up). */
const lines: string[] = [];

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
    { logger: createLogger("debug", { write: (line) => lines.push(line) }) },
  );
  rootId = (
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  const otherId = (
    await accountsFor(db).createLocal({
      login: "root2",
      password: PW,
      displayName: "Root Two",
      superAdmin: true,
    })
  ).id;
  root = await session(k, "root");
  orgId = await createOrg(root);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${otherId}, 'admin')`.execute(db);
  other = await session(k, "root2");
  const res = await root({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Mine",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "Platform" }],
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const call = (operation: string, params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;

const reveal = (who: Req, approvalId: string) =>
  who({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/initial-password` });

/** Signs in with a login and password, returning the request function and the response. */
async function signIn(login: string, password: string) {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password },
  });
  return { req, res };
}

describe("accounts.create through the super admin's private agent", { timeout: 180_000 }, () => {
  it("shows the generated password once to the approver and nowhere else", async () => {
    const convId = await createConv(root, orgId, agentId);
    await postMessage(
      root,
      orgId,
      convId,
      call("accounts.create", { login: "alice", displayName: "Alice Chen" }),
    );
    const asked = await waitFor(
      async () => ofType(await eventsOf(db, convId), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    expect(asked.payload.toolKey).toBe("Platform:accounts.create");
    const approvalId = asked.payload.approvalId;

    // nothing to show before the approval
    const early = await reveal(root, approvalId);
    expect(early.statusCode, early.body).toBe(404);
    const ok = await root({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1, 30_000);

    const evs = await eventsOf(db, convId);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result).toMatchObject({ toolKey: "Platform", isError: false });
    const out = JSON.parse(result?.content ?? "{}") as {
      account: { id: string; login: string; mustChangePassword: boolean };
      initialPassword: string;
    };
    expect(out.account).toMatchObject({ login: "alice", mustChangePassword: true });
    expect(out.initialPassword).toBe(INITIAL_PASSWORD_NOTE);

    // another super admin, who did not approve the call, gets nothing
    expect((await reveal(other, approvalId)).statusCode).toBe(404);

    const shown = await reveal(root, approvalId);
    expect(shown.statusCode, shown.body).toBe(200);
    const { password, login, accountId } = shown.json() as {
      password: string;
      login: string;
      accountId: string;
    };
    expect(login).toBe("alice");
    expect(accountId).toBe(out.account.id);
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
    // read once
    const again = await reveal(root, approvalId);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({
      error: { code: "account.initial_password_unavailable" },
    });

    // Review Focus 4: the password appears in no event, approval row, audit row or log line
    const eventRows = await sql<{ payload: unknown }>`
      SELECT payload FROM capybara.conversation_events WHERE conversation_id = ${convId}`.execute(
      db,
    );
    expect(eventRows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(eventRows.rows)).not.toContain(password);
    const approvals = await db.selectFrom("approvals").selectAll().execute();
    expect(JSON.stringify(approvals)).not.toContain(password);
    const audits = await db.selectFrom("audit_events").selectAll().execute();
    expect(JSON.stringify(audits)).not.toContain(password);
    const created = audits.find((a) => a.action === "account.created" && a.target === accountId);
    expect(created?.detail).toMatchObject({
      via: "agent",
      agentConversationId: convId,
      operation: "accounts.create",
      mustChangePassword: true,
    });
    expect(audits.some((a) => a.action === "account.initial_password_shown")).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(password);
    // the sealed copy is gone after the read
    expect(await db.selectFrom("account_initial_passwords").selectAll().execute()).toEqual([]);

    // the new account must change the password before anything else
    const first = await signIn("alice", password);
    expect(first.res.statusCode, first.res.body).toBe(200);
    expect(first.res.json()).toMatchObject({ account: { mustChangePassword: true } });
    const blocked = await first.req({ method: "GET", url: "/api/v1/orgs" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: "auth.password_change_required" } });
    const me = await first.req({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(200);
    const same = await first.req({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: password, newPassword: password },
    });
    expect(same.statusCode).toBe(400);
    const changed = await first.req({
      method: "PUT",
      url: "/api/v1/me/password",
      payload: { currentPassword: password, newPassword: "a brand new passphrase" },
    });
    expect(changed.statusCode, changed.body).toBe(204);
    const now = await first.req({ method: "GET", url: "/api/v1/orgs" });
    expect(now.statusCode, now.body).toBe(200);
    const after = await first.req({ method: "GET", url: "/api/v1/me" });
    expect(after.json()).toMatchObject({ account: { mustChangePassword: false } });
  });

  it("a taken login is refused before the card", async () => {
    const convId = await createConv(root, orgId, agentId);
    await postMessage(
      root,
      orgId,
      convId,
      call("accounts.create", { login: "root2", displayName: "Taken" }),
    );
    await waitForTerminal(db, convId, 1, 30_000);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const result = ofType(evs, "tool_result").at(-1)?.payload;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("account.login_taken");
  });

  it("two creates with the same call id in one conversation but different runs each reach their own approval", async () => {
    const convId = await createConv(root, orgId, agentId);
    const passwords = k.app.get(InitialPasswords);
    const ids: string[] = [];
    for (const [i, runId] of ["run-a", "run-b"].entries()) {
      await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
        VALUES (${runId}, ${convId}, 'completed', 1, ${rootId})`.execute(db);
      await sql`INSERT INTO capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
          requested_for, status, scope, decided_by, decided_at, expires_at, spec_hash)
        VALUES (${`ap-${runId}`}, ${orgId}, ${convId}, ${runId}, 'call_1', 'Platform:accounts.create',
          ${rootId}, 'approved', 'once', ${rootId}, now(), now() + interval '1 hour', 'h')`.execute(
        db,
      );
      const a = await passwords.createAccount(
        { login: `twin${i}`, displayName: `Twin ${i}` },
        rootId,
        { conversationId: convId, runId, callId: "call_1", recipientAccountId: rootId },
      );
      ids.push(a.id);
    }
    const b = await reveal(root, "ap-run-b");
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json()).toMatchObject({ accountId: ids[1], login: "twin1" });
    const a = await reveal(root, "ap-run-a");
    expect(a.json()).toMatchObject({ accountId: ids[0], login: "twin0" });
    expect((await reveal(root, "ap-run-b")).statusCode).toBe(404);
  });

  it("the cleanup job's delete removes only expired sealed passwords", async () => {
    const convId = await createConv(root, orgId, agentId);
    const passwords = k.app.get(InitialPasswords);
    for (const login of ["old1", "new1"]) {
      await passwords.createAccount({ login, displayName: login }, rootId, {
        conversationId: convId,
        runId: `run-${login}`,
        callId: "call_x",
        recipientAccountId: rootId,
      });
    }
    await sql`UPDATE capybara.account_initial_passwords SET expires_at = now() - interval '1 minute'
      WHERE run_id = 'run-old1'`.execute(db);
    await k.app.get(InitialPasswordCleanupJob).cleanup();
    const left = await db
      .selectFrom("account_initial_passwords")
      .select("run_id")
      .where("conversation_id", "=", convId)
      .execute();
    expect(left).toEqual([{ run_id: "run-new1" }]);
    expect(await deleteExpiredInitialPasswords(db)).toBe(0);
  });
});
