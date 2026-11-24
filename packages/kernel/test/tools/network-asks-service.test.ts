import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { onListNote, serviceAskedNote } from "../../src/tools/network-asks.js";
import { fakeDeviceAccessCalls } from "../fixtures/extensions/fake-device-access/index.js";
import { FAKE_INSTANCE_PERMISSION_SUPPORT } from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableExtensions,
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
 * Network asks raised by an extension's service call (browser use spec §7.1): a tool whose device
 * service saw hosts refused by the device's allowlist reports them in the call scope; the pipeline
 * asks the device owner in the call's conversation, offering only "always" (the device's own
 * list: a run grant cannot reach a long-lived service). Approving adds the hosts to the device's
 * list and runs the call again; a host outside the org's hosts is refused without an ask. The
 * `fake-device-access` fixture writes the call scope directly until `reportBlockedHosts` does.
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const NAVIGATE = "plugin__fake-device-access__navigate";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-network-asks-service-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
          FAKE_DEVICE_ACCESS,
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-device-access");
  // the org's effective hosts take a.dev and example.org; evil.dev stays outside them
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { deviceNetwork: { extraHosts: ["a.dev", "example.org"] } },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  conversationId: string;
}

let s: Setup;

/**
 * A member with a session, a `device-fake` device of their own with a host list of its own
 * (a.dev, list-only: an instance boundary) and a conversation on it.
 */
beforeEach(async () => {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      name: "Box",
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify(["a.dev"]),
      report: JSON.stringify({ support: FAKE_INSTANCE_PERMISSION_SUPPORT }),
    })
    .execute();
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  s = { accountId, req, deviceId, conversationId };
});

/** The model calls `navigate` once, its service refused `blocked` (and `blockedAgain` on a re-run). */
const navigate = (blocked: string[], blockedAgain?: string[]) =>
  postMessage(
    s.req,
    orgId,
    s.conversationId,
    `tool:${NAVIGATE}:${JSON.stringify({
      url: "https://example.org/",
      deviceId: s.deviceId,
      blocked,
      ...(blockedAgain !== undefined && { blockedAgain }),
    })}`,
  );

const decide = (id: string, payload: Record<string, unknown>) =>
  s.req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const networkAsks = () =>
  db
    .selectFrom("approvals")
    .select(["id", "status", "tool_key", "scopes", "detail", "requested_for"])
    .where("conversation_id", "=", s.conversationId)
    .where("kind", "=", "network")
    .execute();

const nextAsk = () =>
  waitFor(
    async () => (await networkAsks()).find((a) => a.status === "pending"),
    15_000,
    "a pending network ask",
  );

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const results = async () =>
  ofType(await eventsOf(db, s.conversationId), "tool_result").map((e) => e.payload);

/** The invocations of the conversation's navigate calls so far (one logical call each key). */
const invocations = async () => {
  const keys = new Set(fakeDeviceAccessCalls());
  const counts = [...keys].map((key) => fakeDeviceAccessCalls().filter((x) => x === key).length);
  return { keys: keys.size, counts };
};

const runStatus = async () =>
  (
    await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", s.conversationId)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow()
  ).status;

describe("network asks for extension service calls", () => {
  beforeEach(() => {
    fakeDeviceAccessCalls().splice(0);
  });

  it("blocked hosts from an extension call raise an always-only ask in the call's conversation", async () => {
    await navigate(["example.org"]);
    const ask = await nextAsk();
    expect(ask).toMatchObject({
      tool_key: NAVIGATE,
      scopes: ["always"],
      requested_for: s.accountId,
    });
    expect(ask.detail).toMatchObject({
      kind: "service",
      deviceId: s.deviceId,
      hosts: ["example.org"],
      url: null,
    });
    await waitFor(async () => (await runStatus()) === "waiting", 10_000, "run waiting");
    const evs = await eventsOf(db, s.conversationId);
    expect(ofType(evs, "approval_requested")[0]?.payload).toMatchObject({
      toolKey: NAVIGATE,
      network: { hosts: ["example.org"] },
    });
    expect(ofType(evs, "tool_result")).toEqual([]);
    expect(await invocations()).toEqual({ keys: 1, counts: [1] });
    // "once" is never offered: a run grant cannot reach a long-lived service
    const res = await decide(ask.id, { decision: "approve", scope: "once" });
    expect(res.statusCode).toBe(409);
  });

  it("approving adds the host to the device allowlist and re-runs the call", async () => {
    await navigate(["example.org"]);
    const ask = await nextAsk();
    const res = await decide(ask.id, { decision: "approve", scope: "always" });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const device = await db
      .selectFrom("devices")
      .select("network_hosts")
      .where("id", "=", s.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.network_hosts).toContain("example.org");
    // one logical call, its handler ran twice: the re-run loaded the page
    expect(await invocations()).toEqual({ keys: 1, counts: [2] });
    const [r, ...rest] = await results();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ toolKey: NAVIGATE, isError: false });
    expect(r?.content).toContain("Loaded https://example.org/.");
  });

  it("a denied ask writes the first run's result with the denied note; the call is not run again", async () => {
    await navigate(["example.org"]);
    const ask = await nextAsk();
    const res = await decide(ask.id, { decision: "deny" });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    expect(await invocations()).toEqual({ keys: 1, counts: [1] });
    const [r] = await results();
    expect(r?.content).toContain("Could not load https://example.org/.");
    expect(r?.content).toContain("example.org");
  });

  it("a host outside the org ceiling is refused without an ask", async () => {
    await navigate(["evil.dev"]);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    expect(await networkAsks()).toEqual([]);
    expect(await invocations()).toEqual({ keys: 1, counts: [1] });
    const [r] = await results();
    expect(r?.content).toContain("Could not load https://example.org/.");
    // the note names who can add the host
    expect(r?.content).toContain("an organization admin adds evil.dev");
  });

  it("a re-run refused more hosts gets the already-asked note; no second ask", async () => {
    await navigate(["example.org"], ["cdn.example.org"]);
    const ask = await nextAsk();
    expect((await decide(ask.id, { decision: "approve", scope: "always" })).statusCode).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    expect(await invocations()).toEqual({ keys: 1, counts: [2] });
    expect(await networkAsks()).toHaveLength(1);
    const [r] = await results();
    expect(r?.content).toContain("Could not load https://example.org/.");
    expect(r?.content).toContain(serviceAskedNote(["cdn.example.org"]));
  });

  it("a host the device's list already holds, not yet applied, is not asked about", async () => {
    // a.dev is on the device's own list; the list-only device applies it at its next use
    await navigate(["a.dev"]);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    expect(await networkAsks()).toEqual([]);
    const [r] = await results();
    expect(r?.content).toContain(onListNote(["a.dev"], "next-use"));
  });
});
