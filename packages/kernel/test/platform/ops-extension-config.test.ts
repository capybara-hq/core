import { randomUUID } from "node:crypto";
import { defineExtension, orgAccess, secret, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { DeploymentConfigView } from "../../src/extensions/deployment-config.js";
import { DEPLOYMENT_SECRETS_ORG, secretKey } from "../../src/extensions/deployment-config-store.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { PLUGIN_DEPLOYMENT_CONFIG_TOPIC } from "../../src/extensions/lifecycle-topics.js";
import type { OrgOverrideView } from "../../src/extensions/org-overrides.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { copyPersonFields } from "../../src/platform/ops/extensions.ops.js";
import { deploymentPersonFields } from "../../src/platform/ops/extensions-admin.ops.js";
import { planPersonFields } from "../../src/platform/person-fields.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { importPlugin, type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createConv, eventsOf, postMessage, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * Extension config through the `Platform` tool (platform web parity spec §4, §7.2, Task 9): the
 * deployment config (read, write, clear), the org config and the org's copy of overridable fields
 * (read, write, take, save, drop). Secrets are person fields: the model names them in `askPerson`,
 * the person types them on the card, and they reach the service only through `personInputs`.
 * Values appear in no event, approval, audit row or log line.
 */

const NAME = "person-cfg";
const DEPLOYMENT = z.object({
  region: z.string().default("us"),
  endpoint: orgAccess(z.string().url().optional(), "override"),
  token: orgAccess(secret(z.string().min(1).optional()), "override"),
  master: secret(z.string().min(1).optional()),
});
const ORG = z.object({ baseUrl: z.string().url(), apiKey: secret(z.string().min(1)) });
const real = defineExtension({
  name: NAME,
  version: "1.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: { deployment: DEPLOYMENT, org: ORG },
  setup() {},
});
const entry = [
  'import { defineExtension, orgAccess, secret } from "@capybara-hq/plugin-sdk";',
  'import { z } from "zod";',
  `export default defineExtension({ name: ${JSON.stringify(NAME)}, version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [], permissions: {}, config: {`,
  '  deployment: z.object({ region: z.string().default("us"), endpoint: orgAccess(z.string().url().optional(), "override"), token: orgAccess(secret(z.string().min(1).optional()), "override"), master: secret(z.string().min(1).optional()) }),',
  "  org: z.object({ baseUrl: z.string().url(), apiKey: secret(z.string().min(1)) }),",
  "}, setup() {} });",
].join("\n");

// distinctive values, so "found nowhere" means something
const ORG_KEY = "sk-org-Vq83Lm20Zx91Tt";
const PLATFORM_TOKEN = "tok-platform-Hd72Ks41";
const SEEDED_MASTER = "master-seeded-Pw19Qa";
const COPY_TOKEN = "tok-copy-Jr55Nb07";

let env: OrgEnv;
let ops: PlatformOperations;
let itemId: string;
const lines: string[] = [];

beforeAll(async () => {
  env = await startOrgEnv({
    logger: createLogger("debug", { write: (line) => lines.push(line) }),
  });
  ops = env.k.app.get(PlatformOperations);
  const bytes = await pluginTgz({
    manifest: { name: NAME },
    extension: { manifest: { ...staticManifestOf(real) }, entry },
  });
  itemId = await importPlugin(env, bytes);
  await waitFor(async () => env.k.app.get(ExtensionHost).current(NAME) !== undefined, 15_000, NAME);
});
afterAll(async () => {
  await env?.stop();
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const ctxOf = (accountId: string, over: Partial<OperationContext> = {}): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  errorRole: "superAdmin",
  ...over,
});

/** A context whose person typed `values` on the card (the tool's `personInputs`, without a store). */
const withInputs = (accountId: string, values: Record<string, string>): OperationContext =>
  ctxOf(accountId, {
    personInputs: { paths: Object.keys(values), apply: (fn) => fn(values) },
  });

/** Parses like the tool does, then runs; a service refusal becomes the tool's error. */
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "superAdmin"));
  });
};

const personFieldsOf = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.personFields === undefined) throw new Error(`${id} has no person fields`);
  return o.personFields(o.input.parse(input), ctx);
};

const audits = (action: string) =>
  env.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

type Field = { path: string; secret: boolean; set?: boolean; value?: unknown };

describe("registration", () => {
  it("registers the config operations, never remembered when destructive", () => {
    for (const id of [
      "extensions.platform-config",
      "extensions.platform-set-config",
      "extensions.platform-clear-config",
      "extensions.org-config",
      "extensions.set-org-config",
      "extensions.take-org-config",
      "extensions.save-org-config",
      "extensions.drop-org-config",
    ]) {
      expect(ops.get(id), id).not.toBeNull();
    }
    expect(op("extensions.platform-clear-config").rememberable).toBe(false);
    expect(op("extensions.drop-org-config").rememberable).toBe(false);
    for (const id of [
      "extensions.platform-set-config",
      "extensions.set-org-config",
      "extensions.save-org-config",
    ]) {
      expect(op(id).omits, id).toContain(
        id === "extensions.set-org-config" ? "force" : "secretEntries",
      );
      expect(op(id).personFields, id).toBeTypeOf("function");
    }
  });
});

describe("plugins.set-enabled before the org config exists", () => {
  it("returns plugin.needs_input whose next step names extensions.set-org-config", async () => {
    const o = op("plugins.set-enabled");
    const input = o.input.parse({ itemId, enabled: true });
    const pre = await o.precheck?.(input, ctxOf(env.rootId));
    expect(pre).toMatchObject({ ok: false, code: "plugin.needs_input" });
    expect((pre as { message: string }).message).toContain("extensions.set-org-config");
  });
});

describe("deployment config", () => {
  it("extensions.platform-config shows secrets as set or unset, never their values", async () => {
    const seeded = await env.root({
      method: "PUT",
      url: `/api/v1/admin/extensions/${NAME}/config`,
      payload: { values: { master: SEEDED_MASTER } },
    });
    expect(seeded.statusCode, seeded.body).toBe(200);
    const view = (await run("extensions.platform-config", { name: NAME }, ctxOf(env.rootId))) as {
      fields: Field[];
      schema: unknown;
    };
    const byPath = new Map(view.fields.map((f) => [f.path, f]));
    expect(byPath.get("master")).toMatchObject({ secret: true, set: true });
    expect(byPath.get("master")).not.toHaveProperty("value");
    expect(byPath.get("token")).toMatchObject({ secret: true, set: false });
    expect(view.schema).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain(SEEDED_MASTER);
  });

  it("extensions.platform-set-config asks for the secret fields and stores the typed value", async () => {
    const target = await personFieldsOf(
      "extensions.platform-set-config",
      { name: NAME, values: { region: "eu" }, askPerson: ["token"] },
      ctxOf(env.rootId),
    );
    expect(target.fields.map((f) => [f.path, f.isSet])).toEqual([
      ["token", false],
      ["master", true],
    ]);
    const c = withInputs(env.rootId, { token: PLATFORM_TOKEN });
    const out = await run(
      "extensions.platform-set-config",
      { name: NAME, values: { region: "eu" }, askPerson: ["token"], clearSecrets: ["master"] },
      c,
    );
    expect(JSON.stringify(out)).not.toContain(PLATFORM_TOKEN);
    const view = (await run("extensions.platform-config", { name: NAME }, ctxOf(env.rootId))) as {
      fields: Field[];
    };
    const byPath = new Map(view.fields.map((f) => [f.path, f]));
    expect(byPath.get("token")).toMatchObject({ set: true });
    expect(byPath.get("master")).toMatchObject({ set: false });
    expect(byPath.get("region")).toMatchObject({ value: "eu" });
    const rows = await audits("extension.deployment_config_updated");
    expect(rows.map((r) => r.detail)).toContainEqual(
      expect.objectContaining({
        via: "agent",
        operation: "extensions.platform-set-config",
        agentConversationId: c.conversationId,
        agentRunId: c.runId,
        inputsProvided: ["token"],
      }),
    );
  });

  it("extensions.platform-clear-config clears what is stored, audited as the agent's", async () => {
    const c = ctxOf(env.rootId);
    await run("extensions.platform-clear-config", { name: NAME }, c);
    const view = (await run("extensions.platform-config", { name: NAME }, c)) as {
      fields: Field[];
    };
    expect(view.fields.find((f) => f.path === "token")).toMatchObject({ set: false });
    expect((await audits("extension.config_cleared")).map((r) => r.detail)).toContainEqual(
      expect.objectContaining({ via: "agent", operation: "extensions.platform-clear-config" }),
    );
  });
});

describe("the org's copy of the overridable fields", () => {
  it("save asks for the copy's secret, take refreshes a field, drop follows the platform again", async () => {
    const target = await personFieldsOf(
      "extensions.save-org-config",
      { extension: NAME, values: {} },
      ctxOf(env.rootId),
    );
    expect(target.fields.map((f) => f.path)).toEqual(["token"]);

    const c = withInputs(env.rootId, { token: COPY_TOKEN });
    await run(
      "extensions.save-org-config",
      {
        extension: NAME,
        values: { endpoint: "https://org.example.com" },
        askPerson: ["token"],
      },
      c,
    );
    const read = (await run("extensions.org-config", { extension: NAME }, ctxOf(env.rootId))) as {
      deploymentCopy: { state: string; fields: { path: string; org?: { set?: boolean } }[] };
    };
    expect(read.deploymentCopy.state).toBe("copy");
    expect(read.deploymentCopy.fields.find((f) => f.path === "token")?.org).toEqual({ set: true });
    expect(JSON.stringify(read)).not.toContain(COPY_TOKEN);
    expect((await audits("extension.org_override_saved")).map((r) => r.detail)).toContainEqual(
      expect.objectContaining({
        via: "agent",
        operation: "extensions.save-org-config",
        inputsProvided: ["token"],
      }),
    );

    await run(
      "extensions.take-org-config",
      { extension: NAME, paths: ["endpoint"] },
      ctxOf(env.rootId),
    );
    expect((await audits("extension.org_override_taken")).map((r) => r.detail)).toContainEqual(
      expect.objectContaining({ via: "agent", operation: "extensions.take-org-config" }),
    );

    await run("extensions.drop-org-config", { extension: NAME }, ctxOf(env.rootId));
    const after = (await run("extensions.org-config", { extension: NAME }, ctxOf(env.rootId))) as {
      deploymentCopy: { state: string };
    };
    expect(after.deploymentCopy.state).toBe("following");
    expect((await audits("extension.org_override_reset")).map((r) => r.detail)).toContainEqual(
      expect.objectContaining({ via: "agent", operation: "extensions.drop-org-config" }),
    );
  });
});

describe("the person fields of the org's copy", () => {
  it("asks only for secrets under overridable fields; one under a read-only object is refused", () => {
    const view: OrgOverrideView = {
      state: "following",
      schema: {
        type: "object",
        properties: {
          conn: {
            type: "object",
            "x-org": "readonly",
            properties: { host: { type: "string" }, key: { type: "string", "x-secret": true } },
          },
          token: { type: "string", "x-secret": true, "x-org": "override" },
        },
      },
      fields: [
        { path: "conn.host", level: "readonly", secret: false, platform: { value: "h" } },
        { path: "conn.key", level: "readonly", secret: true, platform: { set: true } },
        { path: "token", level: "override", secret: true, platform: { set: false } },
      ],
      valid: true,
      issues: [],
    };
    const found = copyPersonFields(view);
    expect(found.fields.map((f) => f.path)).toEqual(["token"]);
    expect(found.recordOnly).toContain("conn.key");
    const t = { target: { zh: "副本", en: "Copy" }, ...found };
    const refused = planPersonFields(t, {
      values: { conn: { key: "key-Lm40" } },
      askPerson: [],
      clearSecrets: [],
    });
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).not.toContain("key-Lm40");
    expect(planPersonFields(t, { askPerson: ["conn.key"], clearSecrets: [] })).toMatchObject({
      ok: false,
    });
  });
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

describe("extensions.set-org-config through the Platform tool (acceptance 1 and 2)", () => {
  it("asks for the API key on the card, stores it from the sealed value, and leaks it nowhere", async () => {
    const res = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Configurer",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff("Platform"),
        },
        visibility: "private",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    const convId = await createConv(env.root, env.orgId, agentId);
    const call = {
      action: "call",
      operation: "extensions.set-org-config",
      params: {
        extension: NAME,
        values: { baseUrl: "https://api.example.com" },
        askPerson: ["apiKey"],
      },
    };
    await postMessage(env.root, env.orgId, convId, `tool:Platform:${JSON.stringify(call)}`);
    const asked = await waitFor(
      async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
      20_000,
      "approval_requested",
    );
    const row = await env.db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", asked.payload.approvalId)
      .executeTakeFirstOrThrow();
    const detail = row.detail as { personFields: { path: string }[] };
    expect(detail.personFields.map((f) => f.path)).toEqual(["apiKey"]);

    // the person types the key on the card: the decision seals it for the resumed call
    const ok = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/approvals/${row.id}/decision`,
      payload: { decision: "approve", scope: "once", inputs: { apiKey: ORG_KEY } },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(env.db, convId, 1, 30_000);
    const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
    expect(result?.isError, result?.content).toBe(false);
    expect(result?.content).toContain("`apiKey`: entered by the person");

    // the org config view shows the key set, never its value
    const list = await env.root({ method: "GET", url: `/api/v1/orgs/${env.orgId}/extensions` });
    expect(list.statusCode, list.body).toBe(200);
    const ext = (
      list.json() as {
        extensions: {
          plugin: string;
          config: Record<string, unknown> | null;
          secrets: { path: string; set: boolean }[];
        }[];
      }
    ).extensions.find((e) => e.plugin === NAME);
    expect(ext?.secrets).toContainEqual({ path: "apiKey", set: true });
    expect(ext?.config).toMatchObject({ baseUrl: "https://api.example.com" });
    const read = (await run("extensions.org-config", { extension: NAME }, ctxOf(env.rootId))) as {
      orgConfig: { secrets: { path: string; set: boolean }[] };
    };
    expect(read.orgConfig.secrets).toContainEqual({ path: "apiKey", set: true });

    const audit = await audits("org.plugin_config.updated");
    expect(audit.map((r) => r.detail)).toContainEqual(
      expect.objectContaining({
        via: "agent",
        operation: "extensions.set-org-config",
        agentConversationId: convId,
        inputsProvided: ["apiKey"],
      }),
    );

    // the key is found in no event, audit row, approval or log line
    const events = await sql<{ payload: unknown }>`
      SELECT payload FROM capybara.conversation_events WHERE conversation_id = ${convId}`.execute(
      env.db,
    );
    expect(JSON.stringify(events.rows)).not.toContain(ORG_KEY);
    expect(
      JSON.stringify(await env.db.selectFrom("audit_events").selectAll().execute()),
    ).not.toContain(ORG_KEY);
    expect(
      JSON.stringify(await env.db.selectFrom("approvals").selectAll().execute()),
    ).not.toContain(ORG_KEY);
    expect(lines.join("\n")).not.toContain(ORG_KEY);
    expect(lines.join("\n")).not.toContain(PLATFORM_TOKEN);
    expect(lines.join("\n")).not.toContain(COPY_TOKEN);
  });
});

describe("read-only secrets of the deployment config", () => {
  const view = (over: Partial<DeploymentConfigView> = {}): DeploymentConfigView => ({
    plugin: NAME,
    displayName: null,
    version: "1.0.0",
    configurable: true,
    fields: [
      { path: "token", secret: true, hot: false, source: "env", readonly: true, set: true },
      { path: "master", secret: true, hot: false, source: "unset", readonly: false, set: false },
    ],
    schema: {
      type: "object",
      properties: {
        token: { type: "string", "x-secret": true },
        master: { type: "string", "x-secret": true },
      },
    },
    valid: true,
    validated: true,
    issues: [],
    orgMustConfigure: [],
    ...over,
  });

  it("are never on the card, and a value for one in values is extension.config_readonly", () => {
    const t = deploymentPersonFields(view());
    expect(t.fields.map((f) => f.path)).toEqual(["master"]);
    expect(t.recordOnly).toContain("token");
    for (const values of [{ token: "tok-Zr81" }, { token: null }, { "token.x": "tok-Zr81" }]) {
      let err: unknown;
      try {
        deploymentPersonFields(view(), [], values);
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: "extension.config_readonly" });
      expect((err as Error).message).toContain("set in the startup config");
      expect((err as Error).message).toContain("token");
      expect((err as Error).message).not.toContain("tok-Zr81");
      expect((err as Error).message).not.toContain("secret record");
    }
    expect(() => deploymentPersonFields(view(), [], { region: "eu" })).not.toThrow();
  });

  it("naming one in askPerson or clearSecrets is extension.config_readonly before the card", () => {
    for (const named of [["token"], ["master", "token"]]) {
      expect(() => deploymentPersonFields(view(), named)).toThrow(
        expect.objectContaining({ code: "extension.config_readonly" }),
      );
    }
    expect(() => deploymentPersonFields(view(), ["master"])).not.toThrow();
  });
});

describe("extensions.platform-set-config through the Platform tool", () => {
  it("applies the sealed value in the consume transaction and publishes only after the commit", async () => {
    const res = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Platform configurer",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff("Platform"),
        },
        visibility: "private",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    // independent of the tests before: no stored deployment secrets, so a stored token can only
    // come from this call
    await run("extensions.platform-clear-config", { name: NAME }, ctxOf(env.rootId));
    expect(
      await env.db
        .selectFrom("secrets")
        .select("key")
        .where("org_id", "=", DEPLOYMENT_SECRETS_ORG)
        .where("key", "=", secretKey(NAME, "token"))
        .executeTakeFirst(),
    ).toBeUndefined();

    // at each publish of the topic, a connection outside the write's transaction looks for the
    // stored secret: before the commit it would not see it
    const bus = env.k.app.get<{ publish(topic: string, msg: unknown): Promise<void> }>(KERNEL_BUS);
    const original = bus.publish.bind(bus);
    const seenAtPublish: boolean[] = [];
    // armed at the decision, so a late publish of the clear above is not counted
    let armed = false;
    bus.publish = async (topic, msg) => {
      if (topic === PLUGIN_DEPLOYMENT_CONFIG_TOPIC && armed) {
        const row = await env.db
          .selectFrom("secrets")
          .select("key")
          .where("org_id", "=", DEPLOYMENT_SECRETS_ORG)
          .where("key", "=", secretKey(NAME, "token"))
          .executeTakeFirst();
        seenAtPublish.push(row !== undefined);
      }
      return original(topic, msg);
    };
    try {
      const convId = await createConv(env.root, env.orgId, agentId);
      const call = {
        action: "call",
        operation: "extensions.platform-set-config",
        params: { name: NAME, values: { region: "ap" }, askPerson: ["token"] },
      };
      await postMessage(env.root, env.orgId, convId, `tool:Platform:${JSON.stringify(call)}`);
      const asked = await waitFor(
        async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
        20_000,
        "approval_requested",
      );
      armed = true;
      const ok = await env.root({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/approvals/${asked.payload.approvalId}/decision`,
        payload: { decision: "approve", scope: "once", inputs: { token: PLATFORM_TOKEN } },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      await waitForTerminal(env.db, convId, 1, 30_000);
      const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
      expect(result?.isError, result?.content).toBe(false);
      expect(result?.content).toContain("`token`: entered by the person");
      await waitFor(async () => seenAtPublish.length > 0, 10_000, "the config topic published");
      expect(seenAtPublish).toEqual([true]);
      const view = (await run("extensions.platform-config", { name: NAME }, ctxOf(env.rootId))) as {
        fields: Field[];
      };
      expect(view.fields.find((f) => f.path === "token")).toMatchObject({ set: true });
      expect(view.fields.find((f) => f.path === "region")).toMatchObject({ value: "ap" });
      expect(lines.join("\n")).not.toContain(PLATFORM_TOKEN);
    } finally {
      bus.publish = original;
    }
  });
});
