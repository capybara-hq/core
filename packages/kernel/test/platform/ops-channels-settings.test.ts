import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { readOrgSettings } from "../../src/orgs/settings.service.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Task 10 of the Platform tool: channel connection and org settings operations against PG with
 * the real services. Operations run by `op.run(input, ctx)`, refusals by `availability()`.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SECRET = "app-secret-9f3c2a7e51d4";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let agentId: string;
let otherAgentId: string;
let ops: PlatformOperations;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CHAN_MINI],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  const o = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const m = await accounts.createLocal({ login: "member", password: PW, displayName: "M" });
  ownerId = o.id;
  memberId = m.id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  otherAgentId = await createAgent(owner, orgId);
  await testMembers(db).add(orgId, m.id, "member", o.id);
  await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  ops = k.app.get(PlatformOperations);
}, 120_000);

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};
const ctxOf = (accountId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId,
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});
const run = (id: string, input: unknown, accountId = ownerId) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctxOf(accountId)).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};
const facts = async (role: ActorFacts["role"]): Promise<ActorFacts> => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: (await readOrgSettings(db, orgId)).platformTool,
});
const audits = (action: string) =>
  db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

describe("channels", () => {
  let id: string;

  it("lists and reads a connection without any credential", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: "Lark bot",
        agentId,
        config: { platformUrl: im.url, appId: "cli_1", appSecret: SECRET },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    id = (res.json() as { channel: { id: string } }).channel.id;

    const list = (await run("channels.list", {})) as { items: Record<string, unknown>[] };
    expect(list.items).toEqual([
      {
        id,
        name: "Lark bot",
        state: "active",
        plugin: "chan-mini",
        agentId,
        unboundPolicy: "bind",
      },
    ]);
    const got = await run("channels.get", { connectionId: id });
    expect(got).toMatchObject({
      channel: {
        id,
        agentId,
        secrets: [
          { path: "appSecret", set: true },
          { path: "webhookToken", set: false },
        ],
      },
    });
    expect(JSON.stringify([list, got])).not.toContain(SECRET);
  });

  it("refuses a member and an unknown connection with the next step", async () => {
    for (const id of ["channels.list", "channels.get", "channels.update", "channels.delete"]) {
      const a = availability(op(id), await facts("member"));
      expect(a.ok, id).toBe(false);
    }
    expect(availability(op("channels.update"), await facts("admin")).ok).toBe(true);
    await expect(run("channels.get", { connectionId: "nope" })).rejects.toThrow(/channels\.list/);
    const pre = await op("channels.update").precheck?.(
      { connectionId: "nope", status: "disabled" },
      ctxOf(ownerId),
    );
    expect(pre).toMatchObject({ ok: false, code: "channel.not_found" });
  });

  it("denies the known failures before the card", async () => {
    const pre = (input: Record<string, unknown>) =>
      op("channels.update").precheck?.(
        op("channels.update").input.parse({ connectionId: id, ...input }),
        ctxOf(ownerId),
      );
    expect(await pre({ agentId: "no-such-agent" })).toMatchObject({
      ok: false,
      code: "agent.not_found",
    });
    // chan-mini has no webhook support
    expect(await pre({ inboundMode: "webhook" })).toMatchObject({
      ok: false,
      code: "channel.webhook_unavailable",
    });
    expect(await pre({ agentId: otherAgentId, status: "disabled" })).toEqual({ ok: true });
  });

  it("changes the binding with the agent audit detail; credentials are not an input", async () => {
    const o = op("channels.update");
    expect(o.confirm).toBe("org");
    expect(() => o.input.parse({ connectionId: id, config: { appSecret: "x" } })).toThrow();
    expect(() => o.input.parse({ connectionId: id })).toThrow();
    const input = { connectionId: id, agentId: otherAgentId, unboundPolicy: "anonymous" };
    const summary = await o.summary?.(o.input.parse(input), ctxOf(ownerId));
    expect(summary?.en).toContain("Lark bot");
    const r = await run("channels.update", input);
    expect(r).toMatchObject({
      channel: { agentId: otherAgentId, unboundPolicy: "anonymous", webhookUrl: null },
    });
    expect(r).not.toHaveProperty("note");
    const [a] = await audits("channel.updated");
    expect(a?.detail).toMatchObject({
      changed: ["agentId", "unboundPolicy"],
      via: "agent",
      operation: "channels.update",
    });
  });

  it("deletes a connection (org class) and the next read is not found", async () => {
    const o = op("channels.delete");
    expect(o.confirm).toBe("org");
    await run("channels.delete", { connectionId: id });
    const [a] = await audits("channel.deleted");
    expect(a?.detail).toMatchObject({ via: "agent", operation: "channels.delete" });
    await expect(run("channels.get", { connectionId: id })).rejects.toThrow();
  });
});

describe("org settings", () => {
  it("reads the settings, members included, and refuses a guest-level write", async () => {
    const r = (await run("org-settings.get", {}, memberId)) as {
      settings: { platformTool: string };
    };
    expect(r.settings.platformTool).toBe("on");
    expect(availability(op("org-settings.get"), await facts("member")).ok).toBe(true);
    expect(availability(op("org-settings.update"), await facts("member")).ok).toBe(false);
  });

  it("writes with the agent audit detail", async () => {
    const r = (await run("org-settings.update", { toolSearch: "off", locale: "zh" })) as {
      settings: { toolSearch: string };
      note?: string;
    };
    expect(r.settings.toolSearch).toBe("off");
    expect(r.note).toBeUndefined();
    const [a] = await audits("org.settings_updated");
    expect(a?.detail).toMatchObject({ via: "agent", operation: "org-settings.update" });
    expect(() => op("org-settings.update").input.parse({})).toThrow();
    const pre = await op("org-settings.update").precheck?.(
      { sandboxEgress: { mode: "allowlist", allowHosts: [] } },
      ctxOf(ownerId),
    );
    // the deployment default egress here is not none, so the shared check passes
    expect(pre).toBeDefined();
  });

  it("turning platformTool off applies from the next call and tells the person", async () => {
    const o = op("org-settings.update");
    const input = o.input.parse({ platformTool: "off" });
    const summary = await o.summary?.(input, ctxOf(ownerId));
    expect(summary?.en).toMatch(/Platform tool is off/);
    expect(summary?.zh).toContain("平台工具");
    // before the write the same run may still call
    expect(availability(op("org-settings.update"), await facts("owner")).ok).toBe(true);
    const r = (await run("org-settings.update", { platformTool: "off" })) as { note?: string };
    expect(r.note).toMatch(/switch it back on/);
    // the tool reads the setting on every call: the next one is refused
    const a = availability(op("org-settings.get"), await facts("owner"));
    expect(a).toMatchObject({ ok: false });
    // read-only keeps reads and refuses writes
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { platformTool: "read-only" },
    });
    expect(availability(op("org-settings.get"), await facts("owner")).ok).toBe(true);
    expect(availability(op("org-settings.update"), await facts("owner")).ok).toBe(false);
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { platformTool: "on" },
    });
  });
});
