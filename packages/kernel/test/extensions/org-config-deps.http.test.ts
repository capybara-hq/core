import { fileURLToPath } from "node:url";
import { EXTENSION_POINTS } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { createOrg, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Org extension configuration over HTTP: enabling a plugin with its dependency checks, the
 * permission manifest and config schema the org list reports, and the org's default provider for
 * an extension point. Dependencies match by major: no org-scoped point has two supported majors
 * today, so this file runs a kernel that also accepts channel@2 (the registry entry is restored
 * afterwards; the refusal of unsupported majors itself is resolve.test.ts's).
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let ownerId: string;
let memberId: string;

const PW = "correct horse battery";
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

const channelPoint = EXTENSION_POINTS.channel;

beforeAll(async () => {
  EXTENSION_POINTS.channel = {
    ...(channelPoint as NonNullable<typeof channelPoint>),
    majors: [1, 2],
  };
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      log: { level: "error" },
      extensions: [
        fx("cap-chan-a"),
        fx("cap-chan-b"),
        fx("cap-consumer"),
        fx("orgcfg"),
        fx("cap-chan-v2"),
        fx("cap-consumer-v2"),
        fakeExtensionEntry("fake-web"),
        fakeExtensionEntry("fake-web-2"),
      ],
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (channelPoint) EXTENSION_POINTS.channel = channelPoint;
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
});

type Err = { error?: { code?: string; details?: unknown[] } };

async function setup() {
  const req = asUser(k.http, cookieJar());
  const login = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  const orgId = (res.json() as { org: { id: string } }).org.id;
  const put = (plugin: string, payload: Record<string, unknown>) =>
    req({ method: "PUT", url: `/api/v1/orgs/${orgId}/extensions/${plugin}`, payload });
  return { req, orgId, put };
}

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

/** The point-defaults routes need an owner with an org and a member; accounts come from the file's beforeEach. */
let owner: Req;
let member: Req;
let orgId: string;

describe("组织启用插件：依赖校验", () => {
  it("no provider for an orgScoped dependency -> 409 extension.dependency_missing listing the extension points", async () => {
    const { put } = await setup();
    const res = await put("cap-consumer", { enabled: true });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("extension.dependency_missing");
    expect(body.error?.details).toEqual([{ extensionPoint: "channel@1" }]);
  });

  it("提供方在该组织启用后，依赖方可启用（别的组织的启用不算）", async () => {
    const { put, orgId, req } = await setup();
    expect((await put("cap-chan-a", { enabled: true })).statusCode).toBe(200);
    expect((await put("cap-consumer", { enabled: true })).statusCode).toBe(200);
    // 另一个组织没有启用任何提供方：启用提供方只对当前组织有效
    const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Beta" } });
    const org2 = (res.json() as { org: { id: string } }).org.id;
    const r2 = await req({
      method: "PUT",
      url: `/api/v1/orgs/${org2}/extensions/cap-consumer`,
      payload: { enabled: true },
    });
    expect(r2.statusCode).toBe(409);
    expect(orgId).not.toBe(org2);
  });

  it("disabling the only provider something depends on -> 409 extension.has_dependents; force lets it through", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    await put("cap-consumer", { enabled: true });
    const res = await put("cap-chan-a", { enabled: false });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Err;
    expect(body.error?.code).toBe("extension.has_dependents");
    expect(body.error?.details).toEqual([{ plugin: "cap-consumer", extensionPoint: "channel@1" }]);
    const forced = await put("cap-chan-a", { enabled: false, force: true });
    expect(forced.statusCode).toBe(200);
  });

  it("还有别的已启用提供方时，停用其一不受阻", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    await put("cap-chan-b", { enabled: true });
    await put("cap-consumer", { enabled: true });
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    expect((await put("cap-chan-b", { enabled: false })).statusCode).toBe(409);
  });

  it("没有依赖方时停用不受阻；非布尔 force 被拒", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    expect((await put("cap-chan-a", { force: "yes" })).statusCode).toBe(400);
  });
});

describe("依赖按主版本匹配与未加载提供方", () => {
  it("requires channel@2 不能由 channel@1 的提供方满足，停用只看同主版本的依赖方", async () => {
    const { put } = await setup();
    await put("cap-chan-a", { enabled: true });
    const r = await put("cap-consumer-v2", { enabled: true });
    expect(r.statusCode).toBe(409);
    expect((r.json() as Err).error?.details).toEqual([{ extensionPoint: "channel@2" }]);
    expect((await put("cap-chan-v2", { enabled: true })).statusCode).toBe(200);
    expect((await put("cap-consumer-v2", { enabled: true })).statusCode).toBe(200);
    // 停用 channel@1 提供方不受 channel@2 依赖方影响
    expect((await put("cap-chan-a", { enabled: false })).statusCode).toBe(200);
    const d = await put("cap-chan-v2", { enabled: false });
    expect(d.statusCode).toBe(409);
    expect((d.json() as Err).error?.details).toEqual([
      { plugin: "cap-consumer-v2", extensionPoint: "channel@2" },
    ]);
  });

  it("未加载（如待批准）的提供方即使留有已启用记录也算缺席", async () => {
    const { put, orgId } = await setup();
    await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
      VALUES ('pending-chan', ${orgId}, true)`.execute(raw);
    const res = await put("cap-consumer", { enabled: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Err).error?.code).toBe("extension.dependency_missing");
  });
});

describe("GET 插件列表：权限清单与配置 schema", () => {
  it("permissions 按类别分组并标敏感项；orgConfigSchema 的密钥带 x-secret", async () => {
    const { req, orgId } = await setup();
    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(res.statusCode).toBe(200);
    const { extensions: plugins } = res.json() as {
      extensions: {
        plugin: string;
        permissions: { category: string; sensitive: boolean; items: string[] }[];
        orgConfigSchema: { properties?: Record<string, Record<string, unknown>> } | null;
      }[];
    };
    const consumer = plugins.find((p) => p.plugin === "cap-consumer");
    expect(consumer?.permissions).toEqual(
      expect.arrayContaining([
        {
          category: "provides",
          sensitive: false,
          items: ["counter@1"],
          entries: [{ value: "counter@1", sensitive: false }],
        },
        {
          category: "requires",
          sensitive: false,
          items: ["channel@1"],
          entries: [{ value: "channel@1", sensitive: false }],
        },
        {
          category: "optional",
          sensitive: false,
          items: ["directory@1"],
          entries: [{ value: "directory@1", sensitive: false }],
        },
      ]),
    );
    expect(consumer?.orgConfigSchema).toBeNull();
    const org = plugins.find((p) => p.plugin === "orgcfg");
    const secrets = org?.permissions.find((g) => g.category === "secrets");
    expect(secrets).toMatchObject({
      category: "secrets",
      sensitive: true,
      items: expect.arrayContaining(["org:appSecret"]),
      entries: expect.arrayContaining([
        { value: "org:appSecret", sensitive: true, reason: "secrets" },
      ]),
    });
    expect(org?.orgConfigSchema?.properties?.appSecret?.["x-secret"]).toBe(true);
    expect(org?.orgConfigSchema?.properties?.appId).not.toHaveProperty("x-secret");
  });
});

describe("org extension point defaults over HTTP", () => {
  beforeEach(async () => {
    owner = await session(k, "owner");
    orgId = await createOrg(owner);
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    member = await session(k, "mem");
  });

  async function enable(plugin: string, token: string): Promise<void> {
    const r = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true, config: { token } },
    });
    expect(r.statusCode, r.body).toBe(200);
  }

  it("GET lists both points; PUT sets a default (204); GET shows it effective", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    const before = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({
      points: [
        {
          point: "web-search",
          candidates: ["fake-web", "fake-web-2"],
          default: null,
          effective: null,
        },
        {
          point: "web-fetch",
          candidates: ["fake-web", "fake-web-2"],
          default: null,
          effective: null,
        },
      ],
    });

    const put = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web-2" },
    });
    expect(put.statusCode, put.body).toBe(204);

    const after = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect((after.json() as { points: unknown[] }).points[0]).toEqual({
      point: "web-search",
      candidates: ["fake-web", "fake-web-2"],
      default: "fake-web-2",
      effective: "fake-web-2",
    });
  });

  it("PUT: 400 validation_failed for an extension that is not enabled or a bad body", async () => {
    const notEnabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web" },
    });
    expect(notEnabled.statusCode).toBe(400);
    expect(errCode(notEnabled)).toBe("validation_failed");
    const badBody = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "" },
    });
    expect(badBody.statusCode).toBe(400);
    expect(errCode(badBody)).toBe("validation_failed");
  });

  it("a member: 403 on GET and PUT, 200 on /available without extension names", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-fetch/default`,
      payload: { extension: "fake-web" },
    });
    const put = await member({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web" },
    });
    expect(put.statusCode).toBe(403);
    const list = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect(list.statusCode).toBe(403);

    const available = await member({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/extension-points/available`,
    });
    expect(available.statusCode, available.body).toBe(200);
    expect(available.json()).toEqual({
      points: [
        { point: "web-search", available: false },
        { point: "web-fetch", available: true },
      ],
    });
    expect(available.body).not.toContain("fake-web");
  });
});
