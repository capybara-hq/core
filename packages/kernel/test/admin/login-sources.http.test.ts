import { fileURLToPath } from "node:url";
import {
  seedLoginSources,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LOGIN_SOURCES_SETTING } from "../../src/identity/login-sources.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * The login sources admin routes and Platform operations (login extensions spec §3): the super
 * admin lists the identity sources, turns them on, sets their trusted tenants and orders the
 * login page; the login page follows at once.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const PUBLIC = "https://cap.example";
const URL_LIST = "/api/v1/admin/login-sources";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let root: Req;
let plain: Req;
let rootId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0, publicUrl: PUBLIC },
      auth: { cookieSecure: false },
      extensions: [fixture("fake-idp"), fixture("idp-tenant")],
      extensionConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
      extensionPermissions: { autoApprove: true },
    }),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
  await db.deleteFrom("deployment_settings").where("key", "=", LOGIN_SOURCES_SETTING).execute();
  const accounts = accountsFor(db);
  rootId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  await accounts.createLocal({ login: "plain", password: PW, displayName: "Plain" });
  [root, plain] = await Promise.all([session(k, "root"), session(k, "plain")]);
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Item = {
  plugin: string;
  label: { zh: string; en: string };
  tenant?: { pattern?: string };
  enabled: boolean;
  signUp: string;
  trustedTenants: string[];
  available: boolean;
  needsConfig: boolean;
  callbackUrl: string | null;
};

async function list(): Promise<Item[]> {
  const res = await root({ method: "GET", url: URL_LIST });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: Item[] }).items;
}

async function loginPage(): Promise<string[]> {
  const res = await k.http.inject({ method: "GET", url: "/api/v1/auth/sources" });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sources: { plugin: string }[] }).sources.map((s) => s.plugin);
}

describe("login sources admin routes", () => {
  it("lists loaded identity sources with callbackUrl", async () => {
    await seedLoginSources(db, [{ plugin: "gone-idp", enabled: false }]);
    const items = await list();
    expect(items.map((i) => i.plugin)).toEqual(["fake-idp", "gone-idp", "idp-tenant"]);
    const fake = items[0] as Item;
    expect(fake).toMatchObject({
      label: { en: "Fake IdP" },
      enabled: false,
      signUp: "link",
      trustedTenants: [],
      available: true,
      needsConfig: false,
      callbackUrl: `${PUBLIC}/api/v1/auth/sso/fake-idp/callback`,
    });
    expect(items[1]).toMatchObject({
      label: { zh: "gone-idp", en: "gone-idp" },
      available: false,
    });
    expect(items[2]?.tenant?.pattern).toBe("^T[A-Z0-9]+$");
  });

  it("non super admin gets 403", async () => {
    expect((await plain({ method: "GET", url: URL_LIST })).statusCode).toBe(403);
    const put = await plain({
      method: "PUT",
      url: `${URL_LIST}/fake-idp`,
      payload: { enabled: true },
    });
    expect(put.statusCode).toBe(403);
    const order = await plain({
      method: "PUT",
      url: `${URL_LIST}/order`,
      payload: { plugins: [] },
    });
    expect(order.statusCode).toBe(403);
  });

  it("update then GET /api/v1/auth/sources shows it at once", async () => {
    expect(await loginPage()).toEqual([]);
    const res = await root({
      method: "PUT",
      url: `${URL_LIST}/fake-idp`,
      payload: { enabled: true, signUp: "create", trustedTenants: ["t1"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plugin: "fake-idp",
      enabled: true,
      signUp: "create",
      trustedTenants: ["t1"],
      available: true,
    });
    expect(await loginPage()).toEqual(["fake-idp"]);
  });

  it("order route reorders the login page", async () => {
    for (const plugin of ["fake-idp", "idp-tenant"]) {
      const res = await root({
        method: "PUT",
        url: `${URL_LIST}/${plugin}`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await loginPage()).toEqual(["fake-idp", "idp-tenant"]);
    const res = await root({
      method: "PUT",
      url: `${URL_LIST}/order`,
      payload: { plugins: ["idp-tenant", "fake-idp"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Item[] }).items.map((i) => i.plugin)).toEqual([
      "idp-tenant",
      "fake-idp",
    ]);
    expect(await loginPage()).toEqual(["idp-tenant", "fake-idp"]);
    const bad = await root({
      method: "PUT",
      url: `${URL_LIST}/order`,
      payload: { plugins: ["idp-tenant"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
  });

  it("invalid tenant → 400 login_sources.invalid_tenant", async () => {
    const res = await root({
      method: "PUT",
      url: `${URL_LIST}/idp-tenant`,
      payload: { trustedTenants: ["X1"] },
    });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("login_sources.invalid_tenant");
    const unknown = await root({
      method: "PUT",
      url: `${URL_LIST}/nope`,
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("login_sources.unknown_plugin");
  });

  it("Platform operations list, update and reorder", async () => {
    const ops = k.app.get(PlatformOperations);
    const ctx = {
      orgId: "unused",
      actorAccountId: rootId,
      agentId: "a",
      conversationId: "c",
      runId: null,
      signal: new AbortController().signal,
    } satisfies OperationContext;
    const run = (id: string, input: unknown) => {
      const op = ops.get(id);
      if (!op) throw new Error(`no operation ${id}`);
      return op.run(op.input.parse(input), ctx);
    };
    await run("login-sources.update", { plugin: "fake-idp", enabled: true });
    await run("login-sources.update", { plugin: "idp-tenant", enabled: true });
    const out = (await run("login-sources.reorder", { plugins: ["idp-tenant", "fake-idp"] })) as {
      items: Item[];
    };
    expect(out.items.slice(0, 2).map((i) => i.plugin)).toEqual(["idp-tenant", "fake-idp"]);
    const listed = (await run("login-sources.list", {})) as { items: Item[] };
    expect(listed.items[0]?.callbackUrl).toBe(`${PUBLIC}/api/v1/auth/sso/idp-tenant/callback`);
    expect(await loginPage()).toEqual(["idp-tenant", "fake-idp"]);

    const cfg = (await run("extensions.platform-config", { name: "fake-idp" })) as {
      next?: string;
    };
    expect(cfg.next).toContain("login-sources.update");
  });
});
