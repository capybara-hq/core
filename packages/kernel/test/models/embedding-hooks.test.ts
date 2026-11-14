import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { HookRegistry } from "../../src/extensions/hooks.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { ModelEmbeddings } from "../../src/models/embeddings.js";
import { embedConsumer } from "../fixtures/plugins/embed-consumer/index.js";
import { embedObserver } from "../fixtures/plugins/embed-observer/index.js";
import { embedProbe } from "../fixtures/plugins/model-embed-probe/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  enableExtensions,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * `ctx.models.embed` fires `model.request` (model platform spec B §5.4): policy hooks (DLP) see
 * the texts sent to embedding vendors like every other kernel model call. One payload per call,
 * with no conversation fields; a policy denial sends nothing, records no usage and writes one
 * `hook.denied` audit row.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const PURPOSE = "embed-consumer.memory";
const PROBE = { model: { provider: "model-embed-probe", model: "probe-embed" }, params: {} };
const ORGCALLS = fx("orgcalls");
const HOOK_TIMEOUT_MS = 400;
const DECLARED = [
  { purpose: PURPOSE, kind: "embedding" as const, label: { zh: "记忆", en: "Memory" } },
];
const DENIED_NOPE = 'Model request blocked by the "hooks-probe" policy hook: nope';

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let orgSeq = 0;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [
          MODEL_FAKE,
          fx("model-embed-probe"),
          fx("embed-consumer"),
          fx("embed-observer"),
          fx("hooks-probe"),
          ORGCALLS,
        ],
        extensionConfig: { orgcalls: { baseUrl: "https://platform.test", apiKey: "pk-Zx81plat" } },
        hooks: { timeoutMs: HOOK_TIMEOUT_MS },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(() => {
  embedProbe().calls = [];
  embedObserver().seen = [];
});

const ctx = (): ExtensionContext => {
  const c = embedConsumer().ctx;
  if (!c) throw new Error("embed-consumer is not set up");
  return c;
};

/** A fresh org with the extensions enabled and the purpose mapped to the probe model. */
async function freshOrg(): Promise<string> {
  const orgId = await createOrg(owner, `Org ${++orgSeq}`);
  await enableExtensions(raw, orgId, "embed-consumer", "embed-observer", "hooks-probe");
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/${encodeURIComponent(PURPOSE)}`,
    payload: { target: PROBE },
  });
  expect(res.statusCode, res.body).toBe(200);
  return orgId;
}

async function probeConfig(orgId: string, cfg: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function probeCount(orgId: string): Promise<number> {
  const res = await owner({ method: "GET", url: `/plugins/hooks-probe/counts?orgId=${orgId}` });
  return (res.json() as { counts: Record<string, number> }).counts["model.request"] ?? 0;
}

const usageRows = (orgId: string) =>
  db.selectFrom("model_usage").selectAll().where("org_id", "=", orgId).execute();

const deniedRows = (orgId: string) =>
  db
    .selectFrom("audit_events")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("action", "=", "hook.denied")
    .execute();

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe("model.request for ctx.models.embed", () => {
  it("observe and policy hooks see one payload per call, with every text and no conversation", async () => {
    const orgId = await freshOrg();
    // 6 texts: two provider batches (maxBatch 4), one hook payload
    await ctx().models.embed({
      orgId,
      purpose: PURPOSE,
      input: texts(6),
      dimensions: 16,
      inputType: "query",
    });
    expect(embedProbe().calls).toHaveLength(2);
    const seen = await waitFor(
      async () => (embedObserver().seen.length > 0 ? embedObserver().seen : null),
      10_000,
      "observe hook",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      purpose: "embedding",
      orgId,
      extension: "embed-consumer",
      embeddingPurpose: PURPOSE,
      provider: "model-embed-probe",
      model: "probe-embed",
      input: texts(6),
      dimensions: 16,
      inputType: "query",
    });
    expect(seen[0]).not.toHaveProperty("conversationId");
    expect(seen[0]).not.toHaveProperty("runId");
    expect(await probeCount(orgId)).toBe(1);
    expect(await usageRows(orgId)).toHaveLength(1);
    expect(await deniedRows(orgId)).toEqual([]);
  });

  it("a call with no input sends nothing and fires no hook", async () => {
    const orgId = await freshOrg();
    const out = await ctx().models.embed({ orgId, purpose: PURPOSE, input: [] });
    expect(out.vectors).toEqual([]);
    expect(await probeCount(orgId)).toBe(0);
    expect(embedObserver().seen).toEqual([]);
  });

  it("a policy denial rejects the call: nothing sent, no usage, one hook.denied audit row; other orgs unaffected", async () => {
    const orgA = await freshOrg();
    const orgB = await freshOrg();
    await probeConfig(orgA, { denyModelPurposes: ["embedding"] });

    const err = (await rejection(
      ctx().models.embed({ orgId: orgA, purpose: PURPOSE, input: texts(3) }),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe(DENIED_NOPE);
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgA)).toEqual([]);
    const audit = await deniedRows(orgA);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_account_id).toBeNull();
    expect(audit[0]?.target).toBe("embed-consumer");
    expect(audit[0]?.detail).toEqual({
      mount: "model.request",
      plugin: "hooks-probe",
      reason: "nope",
      cause: "deny",
      purpose: "embedding",
      extension: "embed-consumer",
      embeddingPurpose: PURPOSE,
      provider: "model-embed-probe",
      model: "probe-embed",
    });
    // observe hooks still see the denied call
    await waitFor(async () => embedObserver().seen.length === 1 || null, 10_000, "observe");

    const out = await ctx().models.embed({ orgId: orgB, purpose: PURPOSE, input: texts(3) });
    expect(out.vectors).toHaveLength(3);
    expect(embedProbe().calls).toHaveLength(1);
    expect(await usageRows(orgB)).toHaveLength(1);
    expect(await deniedRows(orgB)).toEqual([]);
  });

  it("a policy hook that throws denies the call (fails closed)", async () => {
    const orgId = await freshOrg();
    await probeConfig(orgId, { throwIn: ["model.request"] });
    const err = (await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(2) }),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe(
      'Model request blocked by the "hooks-probe" policy hook: The hooks-probe policy check failed',
    );
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgId)).toEqual([]);
    const audit = await deniedRows(orgId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({
      cause: "hook_error",
      error: "probe failure in model.request",
    });
  });
  it("a policy hook that times out denies the call", async () => {
    const orgId = await freshOrg();
    await probeConfig(orgId, { sleepMs: 5_000, sleepIn: ["model.request"] });
    const err = (await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(2) }),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe(
      'Model request blocked by the "hooks-probe" policy hook: The hooks-probe policy check did not respond in time',
    );
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgId)).toEqual([]);
    expect((await deniedRows(orgId))[0]?.detail).toMatchObject({ cause: "timeout" });
  });

  it("a policy extension that is not loaded on this replica denies the call", async () => {
    const orgId = await freshOrg();
    // the real registry: deployment state expects guard's policy hook, no instance runs here
    const registry = new HookRegistry({
      instances: () => [],
      current: () => undefined,
      expectedPolicy: (mount) => (mount === "model.request" ? ["guard"] : []),
      enabledPlugins: async () => new Set(["guard"]),
      effectiveConfig: async () => ({ ok: true, config: {}, source: "platform" }),
      locks: k.app.get(LockService),
      config: () => ({ hooks: { timeoutMs: HOOK_TIMEOUT_MS } }),
      log: createLogger("error", { write: () => {} }),
    });
    const err = (await rejection(
      k.app
        .get(ModelEmbeddings)
        .embed(
          "embed-consumer",
          DECLARED,
          { orgId, purpose: PURPOSE, input: texts(2) },
          new AbortController().signal,
          registry,
        ),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe(
      'Model request blocked by the "guard" policy hook: The guard policy check is unavailable',
    );
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgId)).toEqual([]);
    expect((await deniedRows(orgId))[0]?.detail).toMatchObject({
      plugin: "guard",
      cause: "hook_error",
      notLoaded: true,
    });
  });

  it("a policy extension needing configuration in the org denies the call", async () => {
    const orgId = await freshOrg();
    await enableExtensions(raw, orgId, "orgcalls");
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/orgcalls/overrides`,
      payload: { values: { baseUrl: "org-x", apiKey: "ok-x-Pq19org" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    // the copy loses its own secret: it no longer validates (it never takes the platform's)
    await raw
      .deleteFrom("capybara.secrets" as never)
      .where("org_id" as never, "=", orgId as never)
      .where("key" as never, "like", "plugin-override:orgcalls:%" as never)
      .execute();
    await k.app.get(EffectiveConfigs).invalidate(orgId, "orgcalls");
    expect((await k.app.get(EffectiveConfigs).get(orgId, "orgcalls")).ok).toBe(false);
    const err = (await rejection(
      ctx().models.embed({ orgId, purpose: PURPOSE, input: texts(2) }),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe(
      'Model request blocked by the "orgcalls" policy hook: The orgcalls policy check is unavailable',
    );
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgId)).toEqual([]);
    expect((await deniedRows(orgId))[0]?.detail).toMatchObject({
      plugin: "orgcalls",
      needsConfig: true,
    });
  });

  it("escaping an extension route, a denial answers 403 model.hook_denied without the reason", async () => {
    const orgId = await freshOrg();
    await probeConfig(orgId, { denyModelPurposes: ["embedding"] });
    const res = await owner({
      method: "POST",
      url: "/plugins/embed-consumer/embed",
      payload: { orgId, input: texts(2) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: {
        code: "model.hook_denied",
        message: "An organization policy denied this model call",
      },
    });
    expect(embedProbe().calls).toEqual([]);
  });

  it("escaping an extension tool, the model sees the denial text", async () => {
    const orgId = await freshOrg();
    await probeConfig(orgId, { denyModelPurposes: ["embedding"] });
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Memory",
          instructions: "Remember things.",
          model: { provider: "model-fake", model: "fake-1" },
          // extension tools are on by default (tools default-on spec §2)
          disabledTools: builtinsOff(),
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const conv = await createConv(owner, orgId, agentId);
    const sent = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
      payload: { text: 'tool:plugin__embed-consumer__remember:{"texts":["secret"]}' },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitForTerminal(db, conv, 1, 20_000);
    const result = (await eventsOf(db, conv)).find((e) => e.type === "tool_result");
    expect(result?.payload).toMatchObject({ isError: true, content: DENIED_NOPE });
    expect(embedProbe().calls).toEqual([]);
    expect(await usageRows(orgId)).toEqual([]);
  });
});
