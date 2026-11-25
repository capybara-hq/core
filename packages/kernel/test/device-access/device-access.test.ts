import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceAccessError, type ToolCallContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
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
  readFakeSandboxLimits,
  readFakeSandboxOps,
} from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
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
import { childRunsOf } from "../helpers/subagents.js";

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
/** The id the provider knows the fixture's service by (`<extension>.<name>`). */
const ID = "fake-device-access.echo";
/** Another extension declaring the same service name. */
const OTHER: DeviceAccessCaller = { extension: "other-ext", services: ["echo"] };
const OTHER_ID = "other-ext.echo";

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
        extensionConfig: { "device-fake": { root: sandboxRoot, updateMode: "updated" } },
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
  await k.app.get(DeviceServices).stop(use(), ID, AbortSignal.timeout(30_000));
  await k.app.get(DeviceServices).stop(use(), OTHER_ID, AbortSignal.timeout(30_000));
});

/** A tool call context as the pipeline makes it (with the call scope and its run facts). */
const callOf = (over: Partial<ToolCallContext> = {}): ToolCallContext => {
  const call: ToolCallContext = {
    orgId,
    accountId: s.accountId,
    ownerAccountId: s.accountId,
    agentId: s.agentId,
    conversationId: s.conversationId,
    rootConversationId: s.conversationId,
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

const status = () => k.app.get(DeviceServices).status(use(), ID, AbortSignal.timeout(30_000));

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
    expect(first.name).toBe("echo");
    expect(first.stateDir).toMatch(/\/\.svc\/fake-device-access\.echo$/);
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      toolKey: "Bash",
      input: { command: `node ${first.stateDir}/echo.mjs --title 'a b'` },
      // reviewed as the declared service launch it is (allow.service), not as a dev command
      serviceEntry: `${first.stateDir}/echo.mjs`,
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
      serviceId: ID,
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
    await k.app.get(DeviceServices).stop(use(), ID, AbortSignal.timeout(30_000));
    const third = await access.ensureService(CALLER, callOf(), spec);
    expect(third.state).toBe("running");
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("a service running other files (an upgraded extension) is reviewed and restarted on the new ones", async () => {
    const review = allowReview();
    const v1 = echoServiceSpec();
    const first = await access.ensureService(CALLER, callOf(), v1);
    expect(first.state).toBe("running");
    const reviews = review.mock.calls.length;
    const starts = await fakeServiceStarts(sandboxRoot);
    // the same files: kept, no review
    expect(await access.ensureService(CALLER, callOf(), v1)).toEqual(first);
    expect(review).toHaveBeenCalledTimes(reviews);
    // the extension's files changed: a reviewed start, and a new process on the new files
    const script = new TextDecoder().decode(v1.files["echo.mjs"]);
    const v2 = { ...v1, files: { "echo.mjs": new TextEncoder().encode(`${script}\n// v2\n`) } };
    const second = await access.ensureService(CALLER, callOf(), v2);
    expect(second.state).toBe("running");
    expect(second.startedAt).not.toBe(first.startedAt);
    expect(review).toHaveBeenCalledTimes(reviews + 1);
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts + 1);
    // and it answers
    const body = new TextEncoder().encode("ping");
    const answer = await access.request(CALLER, callOf(), {
      service: "echo",
      body,
      timeoutMs: 10_000,
    });
    expect(new TextDecoder().decode(answer)).toBe("ping");
  });

  it("two extensions declaring the same service name run and reach separate services", async () => {
    allowReview();
    const services = k.app.get(DeviceServices);
    const starts = await fakeServiceStarts(sandboxRoot);
    const mine = await access.ensureService(CALLER, callOf(), echoServiceSpec());
    const theirs = await access.ensureService(OTHER, callOf(), echoServiceSpec());
    // each extension sees its own name; the provider keyed them apart
    expect(mine.name).toBe("echo");
    expect(theirs.name).toBe("echo");
    expect(theirs.stateDir).not.toBe(mine.stateDir);
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts + 2);
    const startLines = (await readFakeSandboxOps(sandboxRoot))
      .filter((l) => l[0] === "service-start")
      .map((l) => l[2]);
    expect(startLines.slice(-2)).toEqual([ID, OTHER_ID]);
    // stopping one leaves the other running and reachable
    await services.stop(use(), OTHER_ID, AbortSignal.timeout(30_000));
    expect((await status())?.state).toBe("running");
    const answer = await access.request(CALLER, callOf(), {
      service: "echo",
      body: new TextEncoder().encode("ping"),
      timeoutMs: 5_000,
    });
    expect(new TextDecoder().decode(answer)).toContain("ping");
    await expect(
      access.request(OTHER, callOf(), {
        service: "echo",
        body: new TextEncoder().encode("ping"),
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/not running/);
  });

  it("the launch is reviewed at the service's code directory when the provider reports one", async () => {
    const review = allowReview();
    const services = k.app.get(DeviceServices);
    const original = services.ensure.bind(services);
    const codeDir = "/opt/device/svc-files/echo";
    // a provider keeping code apart from state reports codeDir on every status
    const spy = vi
      .spyOn(services, "ensure")
      .mockImplementation(async (...args) => ({ ...(await original(...args)), codeDir }));
    try {
      const status = await access.ensureService(CALLER, callOf(), echoServiceSpec());
      expect(status.codeDir).toBe(codeDir);
      expect(review.mock.calls[0]?.[0]).toMatchObject({
        input: { command: `node ${codeDir}/echo.mjs` },
        // the working directory stays the state directory
        workspace: status.stateDir,
      });
    } finally {
      spy.mockRestore();
      await services.stop(use(), ID, AbortSignal.timeout(30_000));
    }
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
      await services.ensure(use(), { ...echoServiceSpec(), name: ID }, AbortSignal.timeout(30_000));
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
      () => access.reportBlockedHosts(call, [{ host: "example.org", layer: "device" }]),
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
      rootConversationId: s.conversationId,
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
    const direct = callOf();
    const answer = await access.request(CALLER, direct, {
      service: "echo",
      body: new TextEncoder().encode("again"),
      timeoutMs: 10_000,
    });
    expect(new TextDecoder().decode(answer)).toBe("again");
    // the call reached the service: a later timeout never claims nothing was sent
    expect(callScopeOf(direct)?.reached).toBe(true);
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
    const device = (host: string) => ({ host, layer: "device" as const });
    // before any service call of this call: no device named (the pipeline asks about the
    // conversation's)
    const before = callOf();
    access.reportBlockedHosts(before, [device("example.org")], { url: "https://example.org/a" });
    expect(callScopeOf(before)?.blocked).toEqual({
      deviceId: null,
      hosts: new Map([["example.org", "device"]]),
      url: "https://example.org/a",
    });
    // after the call's service calls: the device they resolved; reports accumulate
    const call = callOf();
    await access.ensureService(CALLER, call, echoServiceSpec());
    access.reportBlockedHosts(call, [device("example.org")]);
    access.reportBlockedHosts(call, [device("cdn.example.org")], { url: "https://example.org/b" });
    const blocked = callScopeOf(call)?.blocked;
    expect(blocked?.deviceId).toBe(s.deviceId);
    expect(blocked?.hosts).toEqual(
      new Map([
        ["example.org", "device"],
        ["cdn.example.org", "device"],
      ]),
    );
    expect(blocked?.url).toBe("https://example.org/b");
    // a context the pipeline did not make gets a scope attached
    const bare: ToolCallContext = {
      orgId,
      accountId: s.accountId,
      ownerAccountId: s.accountId,
      agentId: s.agentId,
      conversationId: s.conversationId,
      rootConversationId: s.conversationId,
      callId: "bare",
      signal: AbortSignal.timeout(30_000),
    };
    expect(callScopeOf(bare)).toBeNull();
    access.reportBlockedHosts(bare, [device("example.org")]);
    expect(callScopeOf(bare)?.blocked?.hosts).toEqual(new Map([["example.org", "device"]]));
  });

  it("reportBlockedHosts keeps the most restrictive layer of a host and drops malformed entries", () => {
    const call = callOf();
    // a private-resolving name the proxy refused for its address; a later device-layer report of
    // the same host (another spelling) never makes it grantable again
    access.reportBlockedHosts(call, [{ host: "intranet.example.org", layer: "address" }]);
    access.reportBlockedHosts(call, [
      { host: "Intranet.Example.org.", layer: "device" },
      { host: "cdn.example.org", layer: "unknown" },
      { host: "cdn.example.org", layer: "device" },
      // malformed: dropped
      "bare.example.org" as never,
      { host: "", layer: "device" },
      { host: "odd.example.org", layer: "nope" } as never,
    ]);
    expect(callScopeOf(call)?.blocked?.hosts).toEqual(
      new Map([
        ["intranet.example.org", "address"],
        ["cdn.example.org", "device"],
      ]),
    );
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
      rootConversationId: s.conversationId,
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

  it("addNetworkHosts takes exact host names only, as an approved ask grants", async () => {
    // the org's ceiling would take the wildcard: the panel path still refuses it
    const owner = await session(k, "owner");
    const settings = (extraHosts: string[]) =>
      owner({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/settings`,
        payload: { deviceNetwork: { extraHosts } },
      });
    expect(
      (await settings(["a.dev", "example.org", "cdn.example.org", "*.example.org"])).statusCode,
    ).toBe(200);
    try {
      await expect(
        access.addNetworkHosts(CALLER, {
          orgId,
          conversationId: s.conversationId,
          accountId: s.accountId,
          hosts: ["example.org", "*.example.org"],
        }),
      ).rejects.toThrow(/exact host names/);
    } finally {
      await settings(["a.dev", "example.org", "cdn.example.org"]);
    }
    const device = await db
      .selectFrom("devices")
      .select("network_hosts")
      .where("id", "=", s.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.network_hosts).toEqual(["a.dev"]);
  });

  it("addNetworkHosts re-applies the limits to a running service and starts nothing when it is stopped", async () => {
    allowReview();
    const ifRunning = async () =>
      (await readFakeSandboxOps(sandboxRoot)).filter(
        (l) => l[0] === "service-if-running" && l[2] === ID,
      );
    const scope = { orgId, conversationId: s.conversationId, accountId: s.accountId };
    // running: an ifRunning ensure after the write
    await access.ensureService(CALLER, callOf(), echoServiceSpec());
    const before = (await ifRunning()).length;
    const starts = await fakeServiceStarts(sandboxRoot);
    await access.addNetworkHosts(CALLER, { ...scope, hosts: ["example.org"] });
    const after = await ifRunning();
    // one ifRunning ensure finds it running, one more after the limits were applied
    expect(after.length).toBe(before + 2);
    expect(after.at(-1)?.[3]).toBe("running");
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts);
    // the running instance got the new allowlist at once (the provider's update), not at the
    // next tool call
    const applied = (await readFakeSandboxLimits(sandboxRoot)).at(-1);
    expect(applied?.op).toBe("update");
    expect(applied?.limits.network.hosts).toContain("example.org");
    // stopped (the instance runs): the ifRunning ensure finds it stopped and starts nothing
    await k.app.get(DeviceServices).stop(use(), ID, AbortSignal.timeout(30_000));
    await access.addNetworkHosts(CALLER, { ...scope, hosts: ["cdn.example.org"] });
    const last = await ifRunning();
    expect(last.length).toBe(before + 3);
    expect(last.at(-1)?.[3]).toBe("stopped");
    expect(await fakeServiceStarts(sandboxRoot)).toBe(starts);
    expect((await status())?.state).toBe("stopped");
  });

  it("a launch reviewed in a round that asks for input keeps its review record and refused hosts", async () => {
    allowReview();
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tool:${HANDOFF_TOOL}:${JSON.stringify({ service: true, blocked: ["example.org"] })}`,
    );
    const q = await waitFor(
      async () =>
        db
          .selectFrom("questions")
          .select(["id", "call_id"])
          .where("conversation_id", "=", s.conversationId)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      15_000,
      "a pending question",
    );
    expect(await fakeServiceStarts(sandboxRoot)).toBeGreaterThan(0);
    await access.answerHandoff(CALLER, {
      orgId,
      conversationId: s.conversationId,
      accountId: s.accountId,
      callId: q.call_id,
      handoffConversationId: s.conversationId,
      done: true,
    });
    // the resumed round starts nothing (the service runs): the hosts refused before the question
    // are asked about after it, and the result still carries the launch's review
    const ask = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select(["id", "detail"])
          .where("conversation_id", "=", s.conversationId)
          .where("kind", "=", "network")
          .where("status", "=", "pending")
          .executeTakeFirst(),
      15_000,
      "the network ask",
    );
    expect(ask.detail).toMatchObject({ kind: "service", hosts: ["example.org"] });
    const res = await s.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
      payload: { decision: "deny" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, s.conversationId, 1, 20_000);
    const [r] = ofType(await eventsOf(db, s.conversationId), "tool_result").map((e) => e.payload);
    expect(r?.content).toMatch(/done: true/);
    expect(r?.review).toEqual({ decision: "allow", by: "rule", rule: null, reason: "test" });
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
    const scope = {
      orgId,
      conversationId: s.conversationId,
      callId: q.call_id,
      handoffConversationId: s.conversationId,
      done: true,
    };
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

/**
 * `answerHandoff` from the root's panel (browser tab ownership spec §5, ruling 11): the question
 * a sub-agent's tool call raised lives in the sub-agent's conversation, named by
 * `handoffConversationId`; only the scope conversation and its descendants are answerable.
 */
describe("ctx.deviceAccess.answerHandoff across a conversation tree", () => {
  const HANDOFF_PROMPT = `tool:${HANDOFF_TOOL}:{}`;

  interface Pending {
    id: string;
    conversationId: string;
    callId: string;
  }

  /** The pending question of conversation `conversationId`, waited for. */
  const pendingIn = (conversationId: string): Promise<Pending> =>
    waitFor(
      async () => {
        const q = await db
          .selectFrom("questions")
          .select(["id", "conversation_id", "call_id"])
          .where("conversation_id", "=", conversationId)
          .where("status", "=", "pending")
          .executeTakeFirst();
        return q ? { id: q.id, conversationId: q.conversation_id, callId: q.call_id } : null;
      },
      20_000,
      `a pending question in ${conversationId}`,
    );

  const statusOf = async (id: string) =>
    (
      await db
        .selectFrom("questions")
        .select("status")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).status;

  /**
   * Makes the root conversation (`s`) one of an agent that may dispatch sub-agents, on the same
   * device, then has it dispatch
   * `n` identical general-purpose sub-agents in one step, each calling the handoff tool first:
   * their pending questions (the same prompt gives the same call id in each).
   */
  const dispatchHandoffs = async (n: number): Promise<Pending[]> => {
    const res = await s.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff("Agent"),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    const conversationId = await createConv(s.req, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ device_id: s.deviceId })
      .where("id", "=", conversationId)
      .execute();
    s = { ...s, agentId, conversationId };
    const call = {
      name: "Agent",
      input: { description: "Hand off", prompt: HANDOFF_PROMPT, subagent_type: "general-purpose" },
    };
    await postMessage(
      s.req,
      orgId,
      s.conversationId,
      `tools:${JSON.stringify(Array.from({ length: n }, () => call))}`,
    );
    const children = await waitFor(
      async () => {
        const c = await childRunsOf(db, s.conversationId);
        return c.length >= n ? c : null;
      },
      20_000,
      `${n} sub-agent(s) dispatched`,
    );
    return Promise.all(children.map((c) => pendingIn(c.conversationId)));
  };

  const root = () => ({ orgId, conversationId: s.conversationId, accountId: s.accountId });

  /**
   * Writes a pending question into `conversationId` under `from`'s call id and tool, as if that
   * conversation's run `runId` had raised it (`attempt` keeps it apart from `from` in one run).
   */
  const plantQuestion = async (
    conversationId: string,
    from: Pending,
    runId: string,
    attempt = 1,
  ): Promise<string> => {
    const src = await db
      .selectFrom("questions")
      .select(["spec", "expires_at"])
      .where("id", "=", from.id)
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    await db
      .insertInto("questions")
      .values({
        id,
        org_id: orgId,
        conversation_id: conversationId,
        run_id: runId,
        call_id: from.callId,
        spec: JSON.stringify(src.spec),
        expires_at: src.expires_at,
        attempt,
      })
      .execute();
    return id;
  };

  const runOf = async (conversationId: string) =>
    (
      await db
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow()
    ).id;

  it("the root answers the named sub-agent's question, never a sibling's with the same call id", async () => {
    const [a, b] = (await dispatchHandoffs(2)) as [Pending, Pending];
    expect(a.conversationId).not.toBe(b.conversationId);
    // callId is unique only within a run: both sub-agents wait under the same one
    expect(a.callId).toBe(b.callId);
    // the parent (the root) waits on a question of the same call id and tool too
    const inRoot = await plantQuestion(s.conversationId, b, await runOf(s.conversationId));
    // a sub-agent's scope answers only its own descendants: not its sibling, not its parent
    for (const handoffConversationId of [b.conversationId, s.conversationId]) {
      await expect(
        access.answerHandoff(CALLER, {
          orgId,
          conversationId: a.conversationId,
          accountId: s.accountId,
          callId: b.callId,
          handoffConversationId,
          done: true,
        }),
      ).rejects.toMatchObject({ code: "question.not_found" });
    }
    expect(await statusOf(inRoot)).toBe("pending");
    // another extension's question in the tree is not this extension's to answer
    const { spec } = await db
      .selectFrom("questions")
      .select("spec")
      .where("id", "=", b.id)
      .executeTakeFirstOrThrow();
    const setKey = (toolKey: unknown) =>
      db
        .updateTable("questions")
        .set({ spec: JSON.stringify({ ...(spec as Record<string, unknown>), toolKey }) })
        .where("id", "=", b.id)
        .execute();
    await setKey("plugin__other-ext__handoff");
    await expect(
      access.answerHandoff(CALLER, {
        ...root(),
        callId: b.callId,
        handoffConversationId: b.conversationId,
        done: true,
      }),
    ).rejects.toMatchObject({ code: "question.not_found" });
    await setKey((spec as Record<string, unknown>).toolKey);
    expect(await statusOf(b.id)).toBe("pending");
    await access.answerHandoff(CALLER, {
      ...root(),
      callId: b.callId,
      handoffConversationId: b.conversationId,
      done: true,
    });
    expect(await statusOf(b.id)).toBe("answered");
    expect(await statusOf(a.id)).toBe("pending");
    // a sub-agent's own scope answers its own question
    await access.answerHandoff(CALLER, {
      orgId,
      conversationId: a.conversationId,
      accountId: s.accountId,
      callId: a.callId,
      handoffConversationId: a.conversationId,
      done: true,
    });
    expect(await statusOf(a.id)).toBe("answered");
  });

  it("a conversation outside the scope's tree is not found: another root, another org, deleted", async () => {
    // another root conversation of the same owner, waiting on its own handoff
    const otherRoot = await createConv(s.req, orgId, s.agentId);
    await postMessage(s.req, orgId, otherRoot, HANDOFF_PROMPT);
    const q = await pendingIn(otherRoot);
    await expect(
      access.answerHandoff(CALLER, {
        ...root(),
        callId: q.callId,
        handoffConversationId: otherRoot,
        done: true,
      }),
    ).rejects.toMatchObject({
      code: "question.not_found",
      message: `No pending question of tool call ${q.callId} in this conversation`,
    });
    expect(await statusOf(q.id)).toBe("pending");
    // a chain through another org: root <- a conversation of org 2 <- a conversation of this org
    // waiting on a question of the call id; the walk stops at the other org's link
    const owner = await session(k, "owner");
    const org2 = await createOrgWithProviders(k, owner, "Other");
    const conv2 = await createConv(owner, org2, await createAgent(owner, org2));
    await db
      .updateTable("conversations")
      .set({ kind: "subagent", parent_conversation_id: s.conversationId })
      .where("id", "=", conv2)
      .execute();
    const below = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, kind, parent_conversation_id)
      VALUES (${below}, ${orgId}, ${s.agentId}, ${s.accountId}, 'subagent', ${conv2})`.execute(db);
    const belowQ = await plantQuestion(below, q, await runOf(otherRoot), 2);
    await expect(
      access.answerHandoff(CALLER, {
        ...root(),
        callId: q.callId,
        handoffConversationId: below,
        done: true,
      }),
    ).rejects.toMatchObject({ code: "question.not_found" });
    expect(await statusOf(belowQ)).toBe("pending");
    // a deleted sub-agent of the tree
    const [child] = (await dispatchHandoffs(1)) as [Pending];
    await db
      .updateTable("conversations")
      .set({ deleted_at: new Date() })
      .where("id", "=", child.conversationId)
      .execute();
    await expect(
      access.answerHandoff(CALLER, {
        ...root(),
        callId: child.callId,
        handoffConversationId: child.conversationId,
        done: true,
      }),
    ).rejects.toMatchObject({ code: "question.not_found" });
    expect(await statusOf(child.id)).toBe("pending");
  });
});
