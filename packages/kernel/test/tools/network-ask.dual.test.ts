import type { DeviceExecArgs, KernelReq } from "@capybara-hq/plugin-sdk";
import { createDualReplicaHarness, type Harness } from "@capybara-hq/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { allowedOnceNote } from "../../src/tools/network-asks.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitFor } from "../helpers/runs.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

/**
 * A network ask across replicas (network ask-to-allow spec §10.3, Review Focus 4): the command
 * runs on a worker against a device held by replica 0's gateway, the run parks, and the device
 * owner's decision sent to both replicas at once is taken once and resumes the run once; the
 * command is never run again.
 */

let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

type Json = Record<string, unknown>;

describe("network ask (dual replica)", () => {
  it("asked on one replica, decided on both at once: one decision, one resume, one exec", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE],
      roles: [
        ["api", "worker", "gateway"],
        ["api", "worker"],
      ],
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: "https://cap.example" },
        sandbox: { limits: { egress: "allowlist", allowHosts: ["*.example.com"] } },
        devices: { local: { reconnectGraceSeconds: 5, leaseTtlMs: 6000 } },
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
        const granted = (req.args as DeviceExecArgs).grants?.hosts ?? [];
        const blocked = granted.includes("files.example.com")
          ? []
          : [{ host: "files.example.com", port: 443, layer: "device" }];
        return {
          ok: true,
          result: {
            exitCode: blocked.length > 0 ? 56 : 0,
            stdout: "",
            stderr: "curl: (56) CONNECT tunnel failed, response 403\n",
            truncated: false,
            timedOut: false,
            ...(blocked.length > 0 && { network: { blocked } }),
          },
        };
      },
      { hello: false },
    );
    cleanups.push(() => machine.close());
    await machine.opened;
    machine.send({
      ...HELLO,
      features: ["networkReport", "policyOp"],
      policy: {
        effectiveTier: "strict",
        isolation: "sandbox",
        localhost: "off",
        unixSockets: "off",
        allowedDomains: [],
        remoteGrants: "owner",
      },
    });
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
    const bash = { command: "curl files.example.com", description: "Fetch" };
    const posted = await call(
      0,
      "POST",
      `/api/v1/orgs/${orgId}/conversations/${conversationId}/messages`,
      {
        text: `tool:Bash:${JSON.stringify(bash)}`,
      },
    );
    expect(posted.status).toBe(202);

    const ask = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", conversationId)
          .where("kind", "=", "network")
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "the network ask",
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
    expect(count("network_blocked")).toBe(1);
    const result = evs.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.payload.content).toContain(
      allowedOnceNote(["files.example.com"]),
    );
    // the command ran once
    const curls = machine.frames.filter(
      (f) =>
        f.type === "req" &&
        f.op === "exec" &&
        (f.args as DeviceExecArgs).command.startsWith("curl"),
    );
    expect(curls).toHaveLength(1);
  }, 180_000);
});
