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
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { planPersonFields } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Channel creation through the `Platform` tool (platform web parity spec §4, §7.2, Task 11): the
 * app secret is a person field, typed on the card and applied through `personInputs`; it appears in
 * no result, no audit row. `channels.schema` shows the form with `x-secret` and no values.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SECRET = "app-secret-Zk40Qw83Lm71";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
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
  const o = await accountsFor(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
  ownerId = o.id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
  await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  ops = k.app.get(PlatformOperations);
});

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
const ctxOf = (over: Partial<OperationContext> = {}): OperationContext => ({
  orgId,
  actorAccountId: ownerId,
  agentId,
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  ...over,
});
const run = (id: string, input: unknown, ctx = ctxOf()) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};
const audits = (action: string) =>
  db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

describe("channels.schema", () => {
  it("shows the form with x-secret on the secret fields and no values", async () => {
    const r = (await run("channels.schema", { plugin: "chan-mini" })) as {
      plugin: string;
      schema: { properties: Record<string, Record<string, unknown>> };
      inbound: { webhookSupported: boolean };
    };
    expect(r.plugin).toBe("chan-mini");
    expect(r.schema.properties.appSecret?.["x-secret"]).toBe(true);
    expect(r.schema.properties.appId?.["x-secret"]).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.inbound.webhookSupported).toBe(false);
  });

  it("refuses a plugin that provides no channel with the next step", async () => {
    await expect(run("channels.schema", { plugin: "no-such" })).rejects.toThrow(/extensions\.list/);
  });
});

describe("channels.create", () => {
  const input = () => ({
    plugin: "chan-mini",
    name: "Lark bot",
    agentId,
    values: { platformUrl: im.url, appId: "cli_1" },
    askPerson: ["appSecret"],
  });

  it("asks the app secret as a person field and refuses it in values", async () => {
    const o = op("channels.create");
    const target = await o.personFields?.(o.input.parse(input()), ctxOf());
    expect(target?.fields.map((f) => f.path)).toContain("appSecret");
    const plan = planPersonFields(target as NonNullable<typeof target>, {
      values: { appSecret: SECRET },
      askPerson: [],
      clearSecrets: [],
    });
    expect(plan.ok).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it("creates the connection with the typed secret; the view shows it as set, never its value", async () => {
    const created = (await run(
      "channels.create",
      input(),
      ctxOf({ personInputs: { paths: ["appSecret"], apply: (fn) => fn({ appSecret: SECRET }) } }),
    )) as { channel: { id: string; secrets: { path: string; set: boolean }[] } };
    expect(created.channel.secrets).toContainEqual({ path: "appSecret", set: true });

    const got = await run("channels.get", { connectionId: created.channel.id });
    expect(got).toMatchObject({
      channel: { name: "Lark bot", plugin: "chan-mini", agentId, status: "active" },
    });
    expect(JSON.stringify([created, got])).not.toContain(SECRET);

    const rows = await audits("channel.created");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      via: "agent",
      operation: "channels.create",
      inputsProvided: ["appSecret"],
    });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe("channels.guide-ack", () => {
  it("is a personal write that refuses an unknown connection with the next step", async () => {
    expect(op("channels.guide-ack").confirm).toBe("personal");
    await expect(
      run("channels.guide-ack", { connectionId: "nope", hash: "0".repeat(64) }),
    ).rejects.toThrow(/channels\.list/);
  });
});
