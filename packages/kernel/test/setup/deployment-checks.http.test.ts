import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fakeExtensionDir,
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { createLogger } from "../../src/log.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { seedGuideFiles } from "../helpers/setup-guides.js";

// The `extension-deployment` setup place (push notifications plan, task C8): a plugin's platform
// setup guide on the super admin's extension page, whose checks get the extension's platform
// deployment config (secrets included) and `orgId: null`. Through fake-push's guide and its
// `fake-push-key` check: the guide list, the cached states, a run redacted by the config's secret
// values (response, Redis, logs), the deployment-scoped cache, the super admin guard on the routes
// and the org routes' refusal, and the mirroring `Platform` operations.

const FAKE_PUSH = fakeExtensionEntry("fake-push");
const BAD_KEY = "bad-key-5f0c2e91d7";
const GOOD_KEY = "good-key-83ab41c6e0";
const GUIDES = "/api/v1/admin/extensions/fake-push/guides";
const CHECKS = `${GUIDES}/fake-push-key/checks`;
const RUN = `${CHECKS}/fake-push-key/run`;

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let root: Req;
let owner: Req;
let rootId: string;
let rootOrgId: string;
let ownerOrgId: string;
let itemId: string;
const lines: string[] = [];

type State = {
  status: string;
  reason?: { en: string; zh?: string };
  fix?: { en: string; zh?: string };
  checkedAt?: string;
  cooldownUntil?: string;
};
type Guide = {
  plugin: string;
  id: string;
  place: string;
  title: string;
  locale: string;
  audience: string;
  mode: string | null;
  checks: { id: string; label: string; source: string }[];
  target: unknown;
  blocks: { kind: string; text?: string }[];
};

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** Seeds the catalog item `fake-push` from the fixture's manifest and guide documents. */
async function seedFakePushItem(): Promise<string> {
  const dir = fakeExtensionDir("fake-push");
  const manifest = JSON.parse(
    await readFile(join(dir, ".capybara-plugin/plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  const docs: Record<string, string> = {};
  for (const path of ["guides/fake-push-key.md", "guides/fake-push-key.zh.md"]) {
    docs[path] = await readFile(join(dir, path), "utf8");
  }
  const files = await seedGuideFiles(db, docs);
  const id = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id,
      name: "fake-push",
      package_name: "@capybara-hq/test-plugin-fake-push",
      publisher: "Capybara",
      description: "Test fake",
      latest_version: "0.1.0",
      policy: "allow",
      disabled: false,
    })
    .execute();
  await db
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version: "0.1.0",
      manifest: JSON.stringify(manifest),
      source: "file",
      source_ref: "upload",
      object_prefix: null,
      files: JSON.stringify(files),
      size: 1000,
    })
    .execute();
  return id;
}

/** Saves the deployment key and waits until this replica runs fake-push with it. */
async function saveKey(key: string): Promise<void> {
  const r = await root({
    method: "PUT",
    url: "/api/v1/admin/extensions/fake-push/config",
    payload: { values: { key } },
  });
  expect(r.statusCode, r.body).toBe(200);
  const registry = k.app.get(ExtensionRegistry);
  await waitFor(
    async () =>
      (registry.current("fake-push")?.config as { key?: string } | undefined)?.key === key,
    10_000,
    "fake-push reloaded with the new key",
  );
}

async function runOk(body: Record<string, unknown> = {}): Promise<State> {
  const r = await root({ method: "POST", url: RUN, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  const result = (r.json() as { result: State }).result;
  for (const key of Object.keys(result)) {
    expect(["status", "reason", "fix", "checkedAt", "cooldownUntil"]).toContain(key);
  }
  return result;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, FAKE_PUSH],
        auth: { cookieSecure: false },
      },
    ),
    { env: {}, logger: createLogger("warn", { write: (l) => lines.push(l) }) },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const accounts = accountsFor(db);
  rootId = (
    await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true })
  ).id;
  await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
  root = await session(k, "root");
  owner = await session(k, "owner");
  rootOrgId = await createOrg(root, "Platform Org");
  ownerOrgId = await createOrg(owner, "Acme");
  itemId = await seedFakePushItem();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  // every test starts with an empty check cache and a fresh rate limit
  const keys = [
    ...(await redis.keys("capk:setup-check*")),
    ...(await redis.keys("throttler:*setup-check")),
  ];
  if (keys.length > 0) await redis.del(...keys);
  lines.length = 0;
});

describe("extension-deployment guides", () => {
  it("lists the platform guide for the super admin, rendered without an org or a target", async () => {
    const r = await root({ method: "GET", url: GUIDES });
    expect(r.statusCode, r.body).toBe(200);
    const { guides } = r.json() as { guides: Guide[] };
    expect(guides).toHaveLength(1);
    const g = guides[0] as Guide;
    expect(g).toMatchObject({
      plugin: "fake-push",
      id: "fake-push-key",
      place: "extension-deployment",
      title: "Connect the fake push service",
      locale: "en",
      audience: "admin",
      mode: null,
      target: null,
    });
    expect(g.checks).toEqual([
      { id: "fake-push-key", label: "The push service accepts the key", source: "plugin" },
    ]);
    expect(JSON.stringify(g.blocks)).toContain("fake-push 0.1.0");

    const zh = await root({ method: "GET", url: `${GUIDES}?locale=zh` });
    expect(zh.statusCode, zh.body).toBe(200);
    expect((zh.json() as { guides: Guide[] }).guides[0]).toMatchObject({
      locale: "zh",
      title: "连接 fake 推送服务",
    });

    // an extension without a catalog item (model-fake) has none; an unknown guide is 404
    const none = await root({ method: "GET", url: "/api/v1/admin/extensions/model-fake/guides" });
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toEqual({ guides: [] });
    const missing = await root({ method: "GET", url: `${GUIDES}/nope/checks` });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(errCode(missing)).toBe("catalog.guide_not_found");
    const notInGuide = await root({
      method: "POST",
      url: `${CHECKS}/other/run`,
      payload: {},
    });
    expect(notInGuide.statusCode, notInGuide.body).toBe(404);
    expect(errCode(notInGuide)).toBe("catalog.check_not_found");
  });

  it("without a key the check fails; the states read not_run, then the cached result", async () => {
    const before = await root({ method: "GET", url: CHECKS });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({ results: { "fake-push-key": { status: "not_run" } } });
    const result = await runOk();
    expect(result).toMatchObject({
      status: "failing",
      reason: { en: "No key is set in the deployment config." },
    });
    expect(result.cooldownUntil).toBeDefined();
    const after = await root({ method: "GET", url: CHECKS });
    expect(
      (after.json() as { results: Record<string, State> }).results["fake-push-key"],
    ).toMatchObject({ status: "failing", checkedAt: result.checkedAt });
    // cached for the deployment, not for an org
    const keys = await redis.keys("capk:setup-check:*");
    expect(keys.filter((key) => !key.endsWith(":cooldown"))).toEqual([
      "capk:setup-check:deployment:extension-deployment:fake-push:fake-push:fake-push-key:-",
    ]);
  });

  it("a bad key fails with the key replaced by [REDACTED] in the response, Redis and the logs", async () => {
    await saveKey(BAD_KEY);
    const r = await root({ method: "POST", url: RUN, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(BAD_KEY);
    expect((r.json() as { result: State }).result).toMatchObject({
      status: "failing",
      reason: { en: "The fake push service refused the key [REDACTED]." },
      fix: { en: "Replace [REDACTED] with a key from the fake push console." },
    });
    const stored = await redis.get(
      "capk:setup-check:deployment:extension-deployment:fake-push:fake-push:fake-push-key:-",
    );
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain(BAD_KEY);
    expect(lines.join("\n")).not.toContain(BAD_KEY);
    // the cached state carries the redacted text only
    const states = await root({ method: "GET", url: CHECKS });
    expect(states.body).not.toContain(BAD_KEY);
  });

  it("a good key passes with orgId null and the deployment target; a forced rerun waits for the cooldown", async () => {
    await saveKey(GOOD_KEY);
    const first = await runOk();
    expect(first).toMatchObject({
      status: "ok",
      reason: { en: "The fake push service accepted the key of fake-push (org: none)." },
    });
    // a fresh result is answered from the cache; force within 10 s keeps it, with the cooldown
    const cached = await runOk();
    expect(cached.checkedAt).toBe(first.checkedAt);
    const forced = await runOk({ force: true });
    expect(forced.checkedAt).toBe(first.checkedAt);
    expect(forced.cooldownUntil).toBeDefined();
  });

  it("replacing only the secret key answers from a new run, not the cached result", async () => {
    await saveKey(BAD_KEY);
    const bad = await runOk();
    expect(bad.status).toBe("failing");
    // the cache keeps the failing result; only the secret changes (configHash leaves it out)
    const hash = k.app.get(ExtensionRegistry).current("fake-push")?.configHash;
    await saveKey(GOOD_KEY);
    expect(k.app.get(ExtensionRegistry).current("fake-push")?.configHash).toBe(hash);
    const good = await runOk();
    expect(good.status).toBe("ok");
    expect(good.checkedAt).not.toBe(bad.checkedAt);
  });

  it("an org admin gets 403 on the deployment routes, and the org routes refuse the deployment guide", async () => {
    for (const [method, url] of [
      ["GET", GUIDES],
      ["GET", CHECKS],
      ["POST", RUN],
    ] as const) {
      const r = await owner({ method, url, ...(method === "POST" && { payload: {} }) });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
    }
    const base = `/api/v1/orgs/${ownerOrgId}/catalog/${itemId}/guides/fake-push-key`;
    const read = await owner({ method: "GET", url: base });
    expect(read.statusCode, read.body).toBe(403);
    expect(errCode(read)).toBe("forbidden");
    const run = await owner({
      method: "POST",
      url: `${base}/checks/fake-push-key/run`,
      payload: {},
    });
    expect(run.statusCode, run.body).toBe(403);
    // nothing ran for the org
    expect(await redis.keys(`capk:setup-check:${ownerOrgId}:*`)).toEqual([]);
  });

  it("the Platform operations mirror the routes as read-class super admin operations", async () => {
    const ops = k.app.get(PlatformOperations);
    const ctx: OperationContext = {
      orgId: rootOrgId,
      actorAccountId: rootId,
      agentId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      signal: new AbortController().signal,
    };
    const call = (id: string, input: unknown) => {
      const o = ops.get(id);
      if (o === null) throw new Error(`no operation ${id}`);
      expect(o.confirm).toBe("read");
      expect(o.authz).toEqual({ superAdmin: true });
      return o.run(o.input.parse(input), ctx) as Promise<Record<string, unknown>>;
    };
    await saveKey(`bad-${BAD_KEY}`);
    const guides = (await call("extensions.platform-guides", { name: "fake-push" })) as {
      guides: Guide[];
    };
    expect(guides.guides.map((g) => g.id)).toEqual(["fake-push-key"]);
    const ran = await call("extensions.platform-check", {
      name: "fake-push",
      guideId: "fake-push-key",
      checkId: "fake-push-key",
    });
    expect(JSON.stringify(ran)).not.toContain(BAD_KEY);
    expect(ran).toMatchObject({
      result: {
        status: "failing",
        reason: { en: "The fake push service refused the key [REDACTED]." },
      },
    });
    const status = await call("extensions.platform-check-status", {
      name: "fake-push",
      guideId: "fake-push-key",
    });
    expect(status).toMatchObject({ results: { "fake-push-key": { status: "failing" } } });
  });
});
