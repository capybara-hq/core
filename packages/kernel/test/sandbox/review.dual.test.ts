import type { DeviceExecArgs, KernelReq } from "@capybara-hq/plugin-sdk";
import { createDualReplicaHarness, type Harness } from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitFor } from "../helpers/runs.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

/**
 * A command ask across replicas (auto mode spec §5.4, multi-replica): the run parks on the
 * replica that ran it, the device owner decides on both replicas at once, exactly one decision
 * takes effect, the run resumes once and the command runs once. The approval row, its detail and
 * the session grant live in PG; the classifier call (none here) never holds a transaction.
 */

let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

type Json = Record<string, unknown>;

const POLICY = { mode: "auto" as const, allowedDomains: [] as string[] };
const PUSH = { command: "git push origin main", description: "Push the branch" };

interface AskScene {
  db: ReturnType<typeof kernelDb>;
  call: (
    index: number,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{
    status: number;
    json: Json;
  }>;
  machine: FakeMachine;
  orgId: string;
  conversationId: string;
  askId: string;
  /** The number of `exec` requests the device has received for the pushed command. */
  execs: () => number;
}

/**
 * Opens a fresh dual-replica scene up to a parked `command` ask: a signed-in owner, a local device
 * on a real WebSocket, an agent and a conversation bound to the device, one posted `git push`
 * (an `ask.force-push`), and the approval row plus the waiting run it produced.
 */
async function openAskScene(): Promise<AskScene> {
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    // replica 0 is the only worker and gateway (it runs every job and owns the device's socket);
    // replica 1 serves the API only. The first message is posted to replica 0, so the run, the ask
    // and the resume are all processed by replica 0's worker, and a decision posted to replica 1
    // can only reach it through PG / Redis, never an in-process cache.
    roles: [["api", "worker", "gateway"], ["api"]],
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
    },
  });
  const harness = h;
  const raw = createDb(harness.dbUrl, 2);
  cleanups.push(() => raw.destroy());
  const db = kernelDb(raw);

  let cookie = "";
  const call = async (index: number, method: string, path: string, body?: unknown) => {
    const res = await harness.requestTo(index, path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (path === "/api/v1/auth/login") {
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
  };

  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  expect(
    (await call(0, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
  ).toBe(200);
  const org = await call(0, "POST", "/api/v1/orgs", { name: "Acme" });
  const orgId = (org.json.org as { id: string }).id;
  const a = await call(0, "POST", "/api/v1/device/authorize", {
    name: "box",
    os: "linux",
    arch: "x64",
    programVersion: "0.1.0",
  });
  await call(0, "POST", "/api/v1/device/confirm", {
    userCode: a.json.userCode,
    orgId,
    name: "Box",
  });
  const t = await call(0, "POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  const { credential, deviceId } = t.json as { credential: string; deviceId: string };

  const machine = new FakeMachine(
    `ws://127.0.0.1:${harness.replicas[0].port}/device/connect`,
    credential,
    (req: KernelReq) => {
      if (req.op === "create") return { ok: true, result: { roots: { ...HELLO.roots } } };
      if (req.op !== "exec") return { ok: true, result: null };
      return {
        ok: true,
        result: { exitCode: 0, stdout: "pushed\n", stderr: "", truncated: false, timedOut: false },
      };
    },
    { hello: false },
  );
  cleanups.push(() => machine.close());
  await machine.opened;
  machine.send({ ...HELLO, features: ["mode"], policy: POLICY });
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("local_policy")
          .where("device_id", "=", deviceId)
          .where("revoked_at", "is", null)
          .executeTakeFirst()
      )?.local_policy != null,
    15_000,
    "hello recorded",
  );

  const agent = await call(0, "POST", `/api/v1/orgs/${orgId}/agents`, {
    definition: {
      name: "Coder",
      instructions: "Use the device.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
    },
    visibility: "org",
  });
  expect(agent.status, JSON.stringify(agent.json)).toBe(201);
  const agentId = (agent.json.agent as { id: string }).id;
  const conv = await call(0, "POST", `/api/v1/orgs/${orgId}/conversations`, { agentId });
  const conversationId = (conv.json.conversation as { id: string }).id;
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  const posted = await call(
    0,
    "POST",
    `/api/v1/orgs/${orgId}/conversations/${conversationId}/messages`,
    { text: `tool:Bash:${JSON.stringify(PUSH)}` },
  );
  expect(posted.status).toBe(202);

  const ask = await waitFor(
    async () =>
      db
        .selectFrom("approvals")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("kind", "=", "command")
        .where("status", "=", "pending")
        .executeTakeFirst(),
    30_000,
    "the command ask",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("runs")
          .select("status")
          .where("conversation_id", "=", conversationId)
          .executeTakeFirst()
      )?.status === "waiting",
    15_000,
    "run waiting",
  );
  // nothing ran while the ask waited
  expect(machine.frames.filter((f) => f.type === "req" && f.op === "exec")).toHaveLength(0);

  return {
    db,
    call,
    machine,
    orgId,
    conversationId,
    askId: ask.id,
    execs: () =>
      machine.frames.filter(
        (f) =>
          f.type === "req" &&
          f.op === "exec" &&
          (f.args as DeviceExecArgs).command === PUSH.command,
      ).length,
  };
}

describe("command ask (dual replica)", () => {
  it("asked on one replica, decided once on both: one decision, one resume, one exec", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE],
      roles: [
        ["api", "worker", "gateway"],
        ["api", "worker"],
      ],
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: "https://cap.example" },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 2);
    cleanups.push(() => raw.destroy());
    const db = kernelDb(raw);

    let cookie = "";
    const call = async (index: number, method: string, path: string, body?: unknown) => {
      const res = await harness.requestTo(index, path, {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (path === "/api/v1/auth/login") {
        cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
      }
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    expect(
      (await call(0, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call(0, "POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const a = await call(0, "POST", "/api/v1/device/authorize", {
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    await call(0, "POST", "/api/v1/device/confirm", {
      userCode: a.json.userCode,
      orgId,
      name: "Box",
    });
    const t = await call(0, "POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const { credential, deviceId } = t.json as { credential: string; deviceId: string };

    const machine = new FakeMachine(
      `ws://127.0.0.1:${harness.replicas[0].port}/device/connect`,
      credential,
      (req: KernelReq) => {
        if (req.op === "create") return { ok: true, result: { roots: { ...HELLO.roots } } };
        if (req.op !== "exec") return { ok: true, result: null };
        return {
          ok: true,
          result: {
            exitCode: 0,
            stdout: "pushed\n",
            stderr: "",
            truncated: false,
            timedOut: false,
          },
        };
      },
      { hello: false },
    );
    cleanups.push(() => machine.close());
    await machine.opened;
    machine.send({ ...HELLO, features: ["mode"], policy: POLICY });
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("device_machines")
            .select("local_policy")
            .where("device_id", "=", deviceId)
            .where("revoked_at", "is", null)
            .executeTakeFirst()
        )?.local_policy != null,
      15_000,
      "hello recorded",
    );

    const agent = await call(0, "POST", `/api/v1/orgs/${orgId}/agents`, {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
      },
      visibility: "org",
    });
    expect(agent.status, JSON.stringify(agent.json)).toBe(201);
    const agentId = (agent.json.agent as { id: string }).id;
    const conv = await call(0, "POST", `/api/v1/orgs/${orgId}/conversations`, { agentId });
    const conversationId = (conv.json.conversation as { id: string }).id;
    await db
      .updateTable("conversations")
      .set({ device_id: deviceId })
      .where("id", "=", conversationId)
      .execute();
    const posted = await call(
      0,
      "POST",
      `/api/v1/orgs/${orgId}/conversations/${conversationId}/messages`,
      { text: `tool:Bash:${JSON.stringify(PUSH)}` },
    );
    expect(posted.status).toBe(202);

    const ask = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", conversationId)
          .where("kind", "=", "command")
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "the command ask",
    );
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("conversation_id", "=", conversationId)
            .executeTakeFirst()
        )?.status === "waiting",
      15_000,
      "run waiting",
    );
    // nothing ran while the ask waited
    expect(machine.frames.filter((f) => f.type === "req" && f.op === "exec")).toHaveLength(0);

    // the owner decides on both replicas at once: one takes it
    const decision = { decision: "approve", scope: "once" };
    const url = `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`;
    const both = await Promise.all([
      call(0, "POST", url, decision),
      call(1, "POST", url, decision),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);

    const evs = await waitFor(
      async () => {
        const e = await eventsOf(db, conversationId);
        return e.some((x) => x.type === "run_finished") ? e : null;
      },
      30_000,
      "run finished",
    );
    const count = (type: ConversationEvent["type"]) => evs.filter((e) => e.type === type).length;
    expect(count("tool_result")).toBe(1);
    expect(count("approval_decided")).toBe(1);
    expect(count("run_finished")).toBe(1);
    expect(count("approval_requested")).toBe(1);
    const result = evs.find(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.payload.isError).toBe(false);
    expect(result?.payload.content).toContain("pushed");
    expect(result?.payload.review).toMatchObject({
      decision: "allow",
      by: "person",
      rule: "ask.force-push",
      scope: "once",
    });
    // the command ran once
    const execs = machine.frames.filter(
      (f) =>
        f.type === "req" && f.op === "exec" && (f.args as DeviceExecArgs).command === PUSH.command,
    );
    expect(execs).toHaveLength(1);
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("org_id", "=", orgId)
      .where("action", "in", ["device.command_allowed", "device.command_denied"])
      .execute();
    expect(audits.map((x) => x.action)).toEqual(["device.command_allowed"]);
  }, 180_000);

  it("decided only on the other replica: the parked run resumes once and the command runs once", async () => {
    const scene = await openAskScene();
    // the run parked on replica 0 (the only worker); the owner's decision reaches only replica 1
    // (api-only), so the resume must travel through PG / Redis to replica 0's worker
    const decision = await scene.call(
      1,
      "POST",
      `/api/v1/orgs/${scene.orgId}/approvals/${scene.askId}/decision`,
      { decision: "approve", scope: "once" },
    );
    expect(decision.status, JSON.stringify(decision.json)).toBe(200);

    const evs = await waitFor(
      async () => {
        const e = await eventsOf(scene.db, scene.conversationId);
        return e.some((x) => x.type === "run_finished") ? e : null;
      },
      30_000,
      "run finished",
    );
    const count = (type: ConversationEvent["type"]) => evs.filter((e) => e.type === type).length;
    expect(count("approval_decided")).toBe(1);
    expect(count("tool_result")).toBe(1);
    expect(count("run_finished")).toBe(1);
    expect(scene.execs()).toBe(1);
  }, 180_000);

  it("a session grant written on one replica suppresses the ask on the other", async () => {
    const scene = await openAskScene();
    const granted = await scene.call(
      1,
      "POST",
      `/api/v1/orgs/${scene.orgId}/approvals/${scene.askId}/decision`,
      { decision: "approve", scope: "session" },
    );
    expect(granted.status, JSON.stringify(granted.json)).toBe(200);
    await waitFor(
      async () =>
        (await eventsOf(scene.db, scene.conversationId)).some((e) => e.type === "run_finished"),
      30_000,
      "the first run finished",
    );
    expect(scene.execs()).toBe(1);

    // the same rule class again, posted to replica 0 (the only worker, where the review runs): the
    // grant was written by replica 1's decision, so this only passes if it is read from PG
    const again = await scene.call(
      0,
      "POST",
      `/api/v1/orgs/${scene.orgId}/conversations/${scene.conversationId}/messages`,
      { text: `tool:Bash:${JSON.stringify(PUSH)}` },
    );
    expect(again.status).toBe(202);
    const evs = await waitFor(
      async () => {
        const e = await eventsOf(scene.db, scene.conversationId);
        return e.filter((x) => x.type === "run_finished").length >= 2 ? e : null;
      },
      30_000,
      "the second run finished",
    );
    const count = (type: ConversationEvent["type"]) => evs.filter((e) => e.type === type).length;
    // the second call was never asked: one card for the conversation, two allowed results
    expect(count("approval_requested")).toBe(1);
    expect(count("tool_result")).toBe(2);
    expect(scene.execs()).toBe(2);
    const last = evs.findLast(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(last?.payload.review).toMatchObject({
      decision: "allow",
      by: "rule",
      rule: "ask.force-push",
    });
  }, 180_000);
});
