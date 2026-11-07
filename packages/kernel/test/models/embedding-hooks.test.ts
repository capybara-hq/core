import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { embedConsumer } from "../fixtures/plugins/embed-consumer/index.js";
import { embedObserver } from "../fixtures/plugins/embed-observer/index.js";
import { embedProbe } from "../fixtures/plugins/model-embed-probe/index.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
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
        ],
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
}, 120_000);

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

describe("model.request for ctx.models.embed", { timeout: 60_000 }, () => {
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
    expect(err.code).toBe("run.hook_denied");
    expect(err.message).toBe('Model request blocked by the "hooks-probe" policy hook: nope');
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
    expect(err.code).toBe("run.hook_denied");
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
});
