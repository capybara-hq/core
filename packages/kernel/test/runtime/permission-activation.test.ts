import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  fakeGroupMessage as group,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import {
  ACTOR_NOT_DEVICE_OWNER_REASON,
  type ConversationEvent,
} from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RunQueue } from "../../src/runtime/run-queue.js";
import { DEVICE_OF_ANOTHER_ACCOUNT_TEXT } from "../../src/tools/builtins/sandbox/common.js";
import { readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
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
 * Gate-on end to end (activation plan B-20 and the non-owner trigger ruling): channel runs whose
 * trigger account is not a device owner record a v1 permission context and still reply. An
 * anonymous guest has no device (`unavailable / no-device`); a run another member triggers in a
 * conversation bound to its owner's device (a wake attributed to that member, say) is
 * `unavailable / actor-device-access` and runs without that device, which is never used by
 * another account.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let im: FakeChannelServer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let guestConn: string;
let agentId: string;
const bashBy = (who: string) =>
  JSON.stringify({ command: `echo from-${who}`, description: "Say who" });

type PermissionContext = Extract<ConversationEvent, { type: "permission_context" }>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  root = await mkdtemp(join(tmpdir(), "cap-permission-activation-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE, CHAN_MINI],
        extensionConfig: { "sandbox-fake": { root } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "member", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin" as const, name: "Bash" }]),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
  for (const [ext, acct] of [
    ["u-owner", ownerId],
    ["u-member", memberId],
  ] as const)
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('chan-mini:t1', ${ext}, ${acct})`.execute(raw);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const mk = async (appId: string, unboundPolicy: "anonymous") => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: appId,
        agentId,
        unboundPolicy,
        config: { platformUrl: im.url, appId, appSecret: "app-secret-1234567" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(id).length === 1, 10_000, `${appId} long connection`);
    return id;
  };
  guestConn = await mk("cli_guest", "anonymous");
});

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function convOf(conn: string, chatId: string): Promise<string> {
  return waitFor(
    async () => {
      const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${conn} AND chat_id = ${chatId}
          AND archived_at IS NULL`.execute(raw);
      return r.rows[0]?.conversation_id;
    },
    10_000,
    "conversation",
  );
}

const contextsOf = async (conv: string, runId?: string): Promise<PermissionContext[]> =>
  (await eventsOf(db, conv)).filter(
    (e): e is PermissionContext =>
      e.type === "permission_context" && (runId === undefined || e.runId === runId),
  );

describe("runs of accounts that own no device here", () => {
  it("an anonymous guest's channel run records an unavailable / no-device context and replies (B-20)", async () => {
    const chat = "grp-guest";
    im.push(guestConn, group("g1", "u-guest", "echo:hello guest", { chatId: chat }));
    const conv = await convOf(guestConn, chat);
    await waitForTerminal(db, conv, 1, 30_000);
    expect((await eventsOf(db, conv)).some((e) => e.type === "run_failed")).toBe(false);
    await waitFor(
      async () => im.sent.find((s) => s.appId === "cli_guest" && s.target.chatId === chat),
      20_000,
      "the guest reply",
    );
    const [context] = await contextsOf(conv);
    expect(context?.payload).toMatchObject({
      version: 1,
      deviceId: null,
      scope: null,
      availability: { state: "unavailable", cause: "no-device" },
    });
  });

  it("a run another member triggers in the owner's conversation runs without the owner's device", async () => {
    // the owner's conversation on their device, used once by the owner
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:Bash:${bashBy("owner")}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const bound = await db
      .selectFrom("conversations")
      .select(["account_id", "device_id"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(bound.account_id).toBe(ownerId);
    expect(bound.device_id).not.toBeNull();
    expect(JSON.stringify(await readFakeSandboxOps(root))).toContain(ownerId);

    // a member's already-authorized message (as a wake or a shared thread attributes a run to
    // another member; the HTTP entrance itself checks ownership)
    await k.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: `tool:Bash:${bashBy("member")}` }],
          authorAccountId: memberId,
        },
      },
    ]);
    await k.app.get(RunQueue).ensureRun(conv);
    await waitForTerminal(db, conv, 2, 30_000);
    const run = await db
      .selectFrom("runs")
      .select(["id", "status", "trigger_account_id"])
      .where("conversation_id", "=", conv)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(run.trigger_account_id).toBe(memberId);
    // the run is not refused for its actor: it finishes
    expect(run.status).toBe("completed");
    const [context] = await contextsOf(conv, run.id);
    expect(context?.payload).toMatchObject({
      deviceId: null,
      selectedProfile: null,
      effectiveProfile: null,
      scope: null,
      availability: {
        state: "unavailable",
        cause: "actor-device-access",
        reason: ACTOR_NOT_DEVICE_OWNER_REASON,
      },
    });
    // the device tool is refused; the owner's device never ran anything for the member
    const result = (await eventsOf(db, conv)).findLast(
      (e) => e.type === "tool_result" && e.runId === run.id,
    ) as Extract<ConversationEvent, { type: "tool_result" }> | undefined;
    expect(result?.payload.isError).toBe(true);
    expect(result?.payload.content).toBe(DEVICE_OF_ANOTHER_ACCOUNT_TEXT);
    const ops = JSON.stringify(await readFakeSandboxOps(root));
    expect(ops).not.toContain(memberId);
    expect(ops).not.toContain("from-member");
  });
});
