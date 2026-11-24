import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceAccessError, type ToolCallContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  DEVICE_ACCESS_NOT_OWNER_TEXT,
  DEVICE_STREAM_TICKET_PREFIX,
  type DeviceAccessCaller,
  DeviceAccessService,
} from "../../src/device-access/device-access.service.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import { CommandReviewService } from "../../src/sandbox/review/review.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import { attachCallScope, callScopeOf } from "../../src/tools/call-scope.js";
import { echoServiceSpec } from "../fixtures/extensions/fake-device-access/index.js";
import {
  FAKE_PERMISSION_SUPPORT,
  fakeServiceStarts,
  readFakeSandboxOps,
} from "../fixtures/plugins/device-fake/index.js";
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
 * `ctx.deviceAccess` (browser use spec §7): an extension's device services in the conversation's
 * device, only for services its manifest declares and only for the conversation's owner on their
 * own device. Through the `fake-device-access` fixture's tools (the real ctx) and, for the
 * refusals and the scope-based calls, through `DeviceAccessService` directly, on a `device-fake`
 * device with the framed echo service.
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const ECHO_TOOL = "plugin__fake-device-access__echo";
const HANDOFF_TOOL = "plugin__fake-device-access__handoff";
const CALLER: DeviceAccessCaller = { extension: "fake-device-access", services: ["echo"] };

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;
let access: DeviceAccessService;

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-device-access-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
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
        http: { port: 0, publicUrl: "https://capybara.example.com" },
      },
    ),
  );
  access = k.app.get(DeviceAccessService);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-device-access");
  // the org's effective hosts take example.org: a device's own list may add it
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { deviceNetwork: { extraHosts: ["a.dev", "example.org", "cdn.example.org"] } },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  conversationId: string;
  agentId: string;
}

let s: Setup;
/** Another member of the org (no device of theirs on the conversation). */
let other: { accountId: string; login: string };

const newMember = async (): Promise<{ accountId: string; login: string }> => {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  return { accountId, login };
};

/** A member with a `device-fake` device of their own (own list: a.dev) and a conversation on it. */
beforeEach(async () => {
  const { accountId, login } = await newMember();
  other = await newMember();
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
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  s = { accountId, req, deviceId, conversationId, agentId };
});

const use = (): SandboxUseContext => ({
  orgId,
  deviceId: s.deviceId,
  holderConversationId: s.conversationId,
  actor: { accountId: s.accountId, conversationId: s.conversationId },
});

// no service process outlives its test
afterEach(async () => {
  vi.restoreAllMocks();
  await k.app.get(DeviceServices).stop(use(), "echo", AbortSignal.timeout(30_000));
});

/** A tool call context as the pipeline makes it (with the call scope and its run facts). */
const callOf = (over: Partial<ToolCallContext> = {}): ToolCallContext => {
  const call: ToolCallContext = {
    orgId,
    accountId: s.accountId,
    ownerAccountId: s.accountId,
    agentId: s.agentId,
    conversationId: s.conversationId,
    callId: `call-${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    signal: AbortSignal.timeout(30_000),
    ...over,
  };
  attachCallScope(call, {
    runId: randomUUID(),
    step: 0,
    rootConversationId: s.conversationId,
    unattended: false,
    agentVersion: 1,
  });
  return call;
};

const allowReview = () =>
  vi
    .spyOn(k.app.get(CommandReviewService), "review")
    .mockResolvedValue({ decision: "allow", by: "rule", reason: "test", rule: null });

const status = () => k.app.get(DeviceServices).status(use(), "echo", AbortSignal.timeout(30_000));

/** The refusal `p` rejects with, as `{ code, message }`. */
const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceAccessError);
    return { code: (e as DeviceAccessError).code, message: (e as DeviceAccessError).message };
  }
  throw new Error("expected a DeviceAccessError");
};

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

describe("ctx.deviceAccess", () => {
  it("ensureService runs the command review once per start and starts the service", async () => {
    const review = allowReview();
    const spec = { ...echoServiceSpec(), args: ["--title", "a b"] };
    const call = callOf();
    const first = await access.ensureService(CALLER, call, spec);
    expect(first.state).toBe("running");
    expect(review).toHaveBeenCalledTimes(1);
    // the command as it runs: node <stateDir>/<entry> <args…>, in the state directory
    expect(first.stateDir).toMatch(/\/\.svc\/echo$/);
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      toolKey: "Bash",
      input: { command: `node ${first.stateDir}/echo.mjs --title 'a b'` },
      workspace: first.stateDir,
      orgId,
      conversationId: s.conversationId,
      accountId: s.accountId,
      attended: true,
    });
    // the verdict is recorded on the call, the start audited
    expect(callScopeOf(call)?.review).toEqual({
      decision: "allow",
      by: "rule",
      rule: null,
      reason: "test",
    });
    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "detail"])
      .where("action", "=", "device.service_started")
      .where("target", "=", s.deviceId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_account_id: s.accountId, org_id: orgId });
    expect(audits[0]?.detail).toEqual({
      extension: "fake-device-access",
      service: "echo",
      deviceId: s.deviceId,
      argv: ["node", `${first.stateDir}/echo.mjs`, "--title", "a b"],
      decision: "allow",
      rule: null,
    });
    // running: found, not reviewed again
    const second = await access.ensureService(CALLER, callOf(), spec);
    expect(second).toEqual(first);
    expect(review).toHaveBeenCalledTimes(1);
    // the service died since: the ifRunning ensure finds it stopped, so it is reviewed again
    await k.app.get(DeviceServices).stop(use(), "echo", AbortSignal.timeout(30_000));
    const third = await access.ensureService(CALLER, callOf(), spec);
    expect(third.state).toBe("running");
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("the env reaches the review as `env K=V`, and a spec that would change what runs is refused", async () => {
    const review = allowReview();
    const withEnv = { ...echoServiceSpec(), env: { MODE: "a b" } };
    const status = await access.ensureService(CALLER, callOf(), withEnv);
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      input: { command: `env 'MODE=a b' node ${status.stateDir}/echo.mjs` },
    });
    review.mockClear();
    for (const bad of [
      {
        ...echoServiceSpec(),
        files: { ...echoServiceSpec().files, "../x.mjs": new Uint8Array(1) },
      },
      { ...echoServiceSpec(), env: { NODE_OPTIONS: "--require /tmp/x.js" } },
    ]) {
      await expect(access.ensureService(CALLER, callOf(), bad)).rejects.toThrow(
        /Invalid device service spec/,
      );
    }
    expect(review).not.toHaveBeenCalled();
  });

  it("review refusal fails closed", async () => {
    for (const decision of ["ask", "deny"] as const) {
      const review = vi
        .spyOn(k.app.get(CommandReviewService), "review")
        .mockResolvedValue({ decision, by: "rule", reason: "not this", rule: "ask.test" });
      const call = callOf();
      await expect(access.ensureService(CALLER, call, echoServiceSpec())).rejects.toThrow(
        /command review did not allow/,
      );
      expect(review).toHaveBeenCalledTimes(1);
      expect((await status())?.state).toBe("stopped");
      // the refusal is the call's review record (an ask nobody can answer here is a deny)
      expect(callScopeOf(call)?.review).toEqual({
        decision: "deny",
        by: "rule",
        rule: "ask.test",
        reason: "not this",
      });
      review.mockRestore();
    }
    // and it reaches the tool_result's review record through the extension's own ctx
    vi.spyOn(k.app.get(CommandReviewService), "review").mockResolvedValue({
      decision: "deny",
      by: "rule",
      reason: "not this",
      rule: "deny.test",
    });
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${ECHO_TOOL}:${JSON.stringify({ text: "hello" })}`,
    );
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = ofType(await eventsOf(db, s.conversationId), "tool_result").map((e) => e.payload);
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/command review did not allow/);
    expect(r?.review).toEqual({
      decision: "deny",
      by: "rule",
      rule: "deny.test",
      reason: "not this",
    });
    expect(
      await db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "device.service_started")
        .where("target", "=", s.deviceId)
        .execute(),
    ).toEqual([]);
  });

  it("a launch another call started during the review is not audited as this call's start", async () => {
    const services = k.app.get(DeviceServices);
    // while this call is being reviewed, another call starts the service
    vi.spyOn(k.app.get(CommandReviewService), "review").mockImplementation(async () => {
      await services.ensure(use(), echoServiceSpec(), AbortSignal.timeout(30_000));
      return { decision: "allow", by: "rule", reason: "test", rule: null };
    });
    const status = await access.ensureService(CALLER, callOf(), echoServiceSpec());
    expect(status.state).toBe("running");
    expect(
      await db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "device.service_started")
        .where("target", "=", s.deviceId)
        .execute(),
    ).toEqual([]);
  });

  it("non-owner trigger is refused", async () => {
    const review = allowReview();
    // a run another member triggered in the owner's conversation
    const call = callOf({ accountId: other.accountId });
    for (const attempt of [
      () => access.ensureService(CALLER, call, echoServiceSpec()),
      () =>
        access.request(CALLER, call, { service: "echo", body: new Uint8Array(1), timeoutMs: 1000 }),
      () => access.reportBlockedHosts(call, ["example.org"]),
    ]) {
      expect(await refusal(attempt)).toEqual({
        code: "not_owner",
        message: "Browser tools only run for the conversation's owner on their own device.",
      });
    }
    expect(DEVICE_ACCESS_NOT_OWNER_TEXT).toBe(
      "Browser tools only run for the conversation's owner on their own device.",
    );
    expect(review).not.toHaveBeenCalled();
    expect(callScopeOf(call)?.blocked).toBeNull();
  });

  it("a call whose root conversation belongs to someone else is refused", async () => {
    const review = allowReview();
    // a sub-agent tree rooted in another member's conversation (a group's), trigger == owner field
    const otherReq = await session(k, other.login);
    const otherConv = await createConv(otherReq, orgId, await createAgent(otherReq, orgId));
    const call: ToolCallContext = {
      orgId,
      accountId: s.accountId,
      ownerAccountId: s.accountId,
      agentId: s.agentId,
      conversationId: s.conversationId,
      callId: "group-call",
      signal: AbortSignal.timeout(30_000),
    };
    attachCallScope(call, {
      runId: randomUUID(),
      step: 0,
      rootConversationId: otherConv,
      unattended: false,
      agentVersion: 1,
    });
    expect(await refusal(access.ensureService(CALLER, call, echoServiceSpec()))).toEqual({
      code: "not_owner",
      message: DEVICE_ACCESS_NOT_OWNER_TEXT,
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("a scope naming another org than the conversation's is refused", async () => {
    expect(
      (
        await refusal(
          access.streamTicket(CALLER, {
            orgId: randomUUID(),
            conversationId: s.conversationId,
            accountId: s.accountId,
            service: "echo",
          }),
        )
      ).code,
    ).toBe("no_device");
  });

  it("undeclared service name is refused", async () => {
    const review = allowReview();
    const spec = { ...echoServiceSpec(), name: "other" };
    expect((await refusal(access.ensureService(CALLER, callOf(), spec))).code).toBe(
      "service_not_declared",
    );
    expect(
      (
        await refusal(
          access.request(CALLER, callOf(), {
            service: "other",
            body: new Uint8Array(1),
            timeoutMs: 1000,
          }),
        )
      ).code,
    ).toBe("service_not_declared");
    expect(
      (
        await refusal(
          access.streamTicket(CALLER, {
            orgId,
            conversationId: s.conversationId,
            accountId: s.accountId,
            service: "other",
          }),
        )
      ).code,
    ).toBe("service_not_declared");
    expect(review).not.toHaveBeenCalled();
  });

  it("request round-trips to the echo service", async () => {
    allowReview();
    // through the extension's own ctx: the fixture's echo tool starts the service and asks it
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${ECHO_TOOL}:${JSON.stringify({ text: "hello device" })}`,
    );
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = ofType(await eventsOf(db, s.conversationId), "tool_result").map((e) => e.payload);
    expect(r?.isError).toBeFalsy();
    expect(r?.content).toBe("hello device");
    // the launch's review is recorded with the call's result, as a reviewed Bash call's is
    expect(r?.review).toEqual({ decision: "allow", by: "rule", rule: null, reason: "test" });
    // and directly, once running
    const answer = await access.request(CALLER, callOf(), {
      service: "echo",
      body: new TextEncoder().encode("again"),
      timeoutMs: 10_000,
    });
    expect(new TextDecoder().decode(answer)).toBe("again");
  });

  it("a refusal reaches the model as its own actionable text", async () => {
    // the conversation's device was deleted: the extension's call is refused with no_device
    await db
      .updateTable("devices")
      .set({ deleted_at: new Date() })
      .where("id", "=", s.deviceId)
      .execute();
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${ECHO_TOOL}:${JSON.stringify({ text: "hello device" })}`,
    );
    await waitForTerminal(db, s.conversationId, 1, 30_000);
    const [r] = ofType(await eventsOf(db, s.conversationId), "tool_result").map((e) => e.payload);
    expect(r?.isError).toBe(true);
    expect(r?.content).toBe("This device does not exist or was deleted.");
  });

  it("reportBlockedHosts lands in the call scope", async () => {
    allowReview();
    // before any service call of this call: no device named (the pipeline asks about the
    // conversation's)
    const before = callOf();
    access.reportBlockedHosts(before, ["example.org"], { url: "https://example.org/a" });
    expect(callScopeOf(before)?.blocked).toEqual({
      deviceId: null,
      hosts: new Set(["example.org"]),
      url: "https://example.org/a",
    });
    // after the call's service calls: the device they resolved; reports accumulate
    const call = callOf();
    await access.ensureService(CALLER, call, echoServiceSpec());
    access.reportBlockedHosts(call, ["example.org"]);
    access.reportBlockedHosts(call, ["cdn.example.org"], { url: "https://example.org/b" });
    const blocked = callScopeOf(call)?.blocked;
    expect(blocked?.deviceId).toBe(s.deviceId);
    expect(blocked?.hosts).toEqual(new Set(["example.org", "cdn.example.org"]));
    expect(blocked?.url).toBe("https://example.org/b");
    // a context the pipeline did not make gets a scope attached
    const bare: ToolCallContext = {
      orgId,
      accountId: s.accountId,
      ownerAccountId: s.accountId,
      agentId: s.agentId,
      conversationId: s.conversationId,
      callId: "bare",
      signal: AbortSignal.timeout(30_000),
    };
    expect(callScopeOf(bare)).toBeNull();
    access.reportBlockedHosts(bare, ["example.org"]);
    expect(callScopeOf(bare)?.blocked?.hosts).toEqual(new Set(["example.org"]));
  });

  it("streamTicket refuses a non-owner and mints a single-use 60 s ticket", async () => {
    const scope = { orgId, conversationId: s.conversationId, service: "echo" };
    expect(
      await refusal(access.streamTicket(CALLER, { ...scope, accountId: other.accountId })),
    ).toEqual({ code: "not_owner", message: DEVICE_ACCESS_NOT_OWNER_TEXT });
    const before = Date.now();
    const minted = await access.mintTicket(
      { orgId, conversationId: s.conversationId, accountId: s.accountId },
      "echo",
      CALLER,
    );
    expect(minted.id).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(minted.url).toBe(`https://capybara.example.com/device/stream?ticket=${minted.id}`);
    const expires = Date.parse(minted.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 59_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
    const key = `${DEVICE_STREAM_TICKET_PREFIX}${minted.id}`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(JSON.parse((await redis.get(key)) as string)).toEqual({
      orgId,
      accountId: s.accountId,
      conversationId: s.conversationId,
      deviceId: s.deviceId,
      providerName: "device-fake",
      service: "echo",
      extension: "fake-device-access",
    });
    // single use: taken once, then gone
    expect((await access.takeTicket(minted.id))?.deviceId).toBe(s.deviceId);
    expect(await access.takeTicket(minted.id)).toBeNull();
    // the ctx form answers the URL and the expiry only
    const viaCtx = await access.streamTicket(CALLER, { ...scope, accountId: s.accountId });
    expect(Object.keys(viaCtx).sort()).toEqual(["expiresAt", "url"]);
  });

  it("addNetworkHosts by the owner writes the device allowlist and audits device.network_changed", async () => {
    expect(
      await refusal(
        access.addNetworkHosts(CALLER, {
          orgId,
          conversationId: s.conversationId,
          accountId: other.accountId,
          hosts: ["example.org"],
        }),
      ),
    ).toEqual({ code: "not_owner", message: DEVICE_ACCESS_NOT_OWNER_TEXT });
    await access.addNetworkHosts(CALLER, {
      orgId,
      conversationId: s.conversationId,
      accountId: s.accountId,
      hosts: ["example.org"],
    });
    const device = await db
      .selectFrom("devices")
      .select("network_hosts")
      .where("id", "=", s.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.network_hosts).toEqual(["a.dev", "example.org"]);
    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "action", "detail"])
      .where("target", "=", s.deviceId)
      .where("action", "=", "device.network_changed")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_account_id).toBe(s.accountId);
  });

  it("addNetworkHosts re-applies the limits to a running service and starts nothing when it is stopped", async () => {
    allowReview();
    const ifRunning = async () =>
      (await readFakeSandboxOps(sandboxRoot)).filter(
        (l) => l[0] === "service-if-running" && l[2] === "echo",
      );
    const scope = { orgId, conversationId: s.conversationId, accountId: s.accountId };
    // running: an ifRunning ensure after the write
    await access.ensureService(CALLER, callOf(), echoServiceSpec());
    const before = (await ifRunning()).length;
    const starts = await fakeServiceStarts(sandboxRoot);
    await access.addNetworkHosts(CALLER, { ...scope, hosts: ["example.org"] });
    const after = await ifRunning();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.[3]).toBe("running");
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts);
    // stopped (the instance runs): the ifRunning ensure finds it stopped and starts nothing
    await k.app.get(DeviceServices).stop(use(), "echo", AbortSignal.timeout(30_000));
    await access.addNetworkHosts(CALLER, { ...scope, hosts: ["cdn.example.org"] });
    const last = await ifRunning();
    expect(last.length).toBe(before + 2);
    expect(last.at(-1)?.[3]).toBe("stopped");
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts);
    expect((await status())?.state).toBe("stopped");
  });

  it("answerHandoff answers the call's question with done=true", async () => {
    await postMessage(s.req, orgId, s.conversationId, `tool:${HANDOFF_TOOL}:{}`);
    const q = await waitFor(
      async () =>
        db
          .selectFrom("questions")
          .select(["id", "call_id", "status"])
          .where("conversation_id", "=", s.conversationId)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      15_000,
      "a pending question",
    );
    const scope = { orgId, conversationId: s.conversationId, callId: q.call_id, done: true };
    expect(
      await refusal(access.answerHandoff(CALLER, { ...scope, accountId: other.accountId })),
    ).toEqual({ code: "not_owner", message: DEVICE_ACCESS_NOT_OWNER_TEXT });
    // a question another extension's tool raised is not this extension's to answer
    const raw = await db
      .selectFrom("questions")
      .select("spec")
      .where("id", "=", q.id)
      .executeTakeFirstOrThrow();
    const spec = raw.spec as Record<string, unknown>;
    const setKey = (toolKey: unknown) =>
      db
        .updateTable("questions")
        .set({ spec: JSON.stringify({ ...spec, toolKey }) })
        .where("id", "=", q.id)
        .execute();
    await setKey("plugin__other-ext__handoff");
    await expect(
      access.answerHandoff(CALLER, { ...scope, accountId: s.accountId }),
    ).rejects.toMatchObject({ code: "question.not_found" });
    await setKey(spec.toolKey);
    await access.answerHandoff(CALLER, { ...scope, accountId: s.accountId });
    const after = await db
      .selectFrom("questions")
      .select(["status", "answer"])
      .where("id", "=", q.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("answered");
    expect(after.answer).toEqual({ done: true });
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const results = ofType(await eventsOf(db, s.conversationId), "tool_result");
    expect(results.at(-1)?.payload.content).toBe("done: true");
  });
});
