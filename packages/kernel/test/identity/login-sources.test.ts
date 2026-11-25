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
import { ApiError } from "../../src/errors.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { LOGIN_SOURCES_SETTING, LoginSourcesService } from "../../src/identity/login-sources.js";
import { SsoFlow } from "../../src/identity/sso.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let svc: LoginSourcesService;
let actor: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0, publicUrl: "https://cap.example" },
      auth: { cookieSecure: false },
      extensions: [
        fixture("fake-idp"),
        fixture("idp-tenant"),
        fixture("idp-unconfigured"),
        fixture("idp-org-field"),
      ],
      extensionConfig: { "fake-idp": { tenant: "t1", clientSecret: "s3cret" } },
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  svc = k.app.get(LoginSourcesService);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
  await db.deleteFrom("deployment_settings").where("key", "=", LOGIN_SOURCES_SETTING).execute();
  actor = (
    await accountsFor(db).createLocal({
      login: "root",
      password: "correct horse battery",
      displayName: "Root",
    })
  ).id;
});

async function refused(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe("LoginSourcesService", () => {
  it("update enables and appends to the order", async () => {
    await svc.update("idp-tenant", { enabled: true }, actor);
    const fake = await svc.update("fake-idp", { enabled: true }, actor);
    expect(fake).toEqual({ plugin: "fake-idp", enabled: true, signUp: "link", trustedTenants: [] });
    expect((await svc.enabled()).map((e) => e.plugin)).toEqual(["idp-tenant", "fake-idp"]);
    // switched off, then on again: back at the end of the enabled ones
    await svc.update("idp-tenant", { enabled: false }, actor);
    await svc.update("idp-tenant", { enabled: true }, actor);
    expect((await svc.list()).map((e) => e.plugin)).toEqual(["fake-idp", "idp-tenant"]);
    expect((await k.app.get(SsoFlow).sources()).map((s) => s.plugin)).toEqual([
      "fake-idp",
      "idp-tenant",
    ]);
  });

  it("reorder rejects a non-permutation", async () => {
    await svc.update("fake-idp", { enabled: true }, actor);
    await svc.update("idp-tenant", { enabled: true }, actor);
    for (const bad of [["fake-idp"], ["fake-idp", "fake-idp"], ["fake-idp", "idp-tenant", "x"]]) {
      const err = await refused(svc.reorder(bad, actor));
      expect(err.code).toBe("validation_failed");
      expect(err.status).toBe(400);
    }
    const after = await svc.reorder(["idp-tenant", "fake-idp"], actor);
    expect(after.map((e) => e.plugin)).toEqual(["idp-tenant", "fake-idp"]);
    expect((await svc.enabled()).map((e) => e.plugin)).toEqual(["idp-tenant", "fake-idp"]);
  });

  it("disabled entries keep their place after the enabled ones on reorder", async () => {
    await seedLoginSources(db, [
      { plugin: "fake-idp" },
      { plugin: "gone", enabled: false },
      { plugin: "idp-tenant" },
    ]);
    const after = await svc.reorder(["idp-tenant", "fake-idp"], actor);
    expect(after.map((e) => e.plugin)).toEqual(["idp-tenant", "fake-idp", "gone"]);
  });

  it("invalid tenant is refused with login_sources.invalid_tenant", async () => {
    // fake-idp declares no tenant: only a blank id is refused
    const blank = await refused(svc.update("fake-idp", { trustedTenants: ["t1", " "] }, actor));
    expect(blank.code).toBe("login_sources.invalid_tenant");
    expect(blank.status).toBe(400);
    const ok = await svc.update("fake-idp", { trustedTenants: [" t1 ", "anything", "t1"] }, actor);
    expect(ok.trustedTenants).toEqual(["t1", "anything"]);
    // idp-tenant declares `^T[A-Z0-9]+$` and never trusts TPUBLIC
    const pattern = await refused(svc.update("idp-tenant", { trustedTenants: ["X1"] }, actor));
    expect(pattern.code).toBe("login_sources.invalid_tenant");
    expect(pattern.message).toContain("X1");
    const never = await refused(svc.update("idp-tenant", { trustedTenants: ["TPUBLIC"] }, actor));
    expect(never.code).toBe("login_sources.invalid_tenant");
    expect(never.message).toContain("TPUBLIC");
    expect(
      (await svc.update("idp-tenant", { trustedTenants: ["T0123"] }, actor)).trustedTenants,
    ).toEqual(["T0123"]);
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect((await refused(svc.update("fake-idp", { trustedTenants: many }, actor))).code).toBe(
      "validation_failed",
    );
  });

  it("isTrusted matches the full key only", async () => {
    await svc.update("fake-idp", { trustedTenants: ["t1"] }, actor);
    expect(await svc.isTrusted("fake-idp:t1")).toBe(true);
    expect(await svc.isTrusted("fake-idp:t2")).toBe(false);
    expect(await svc.isTrusted("fake-idp")).toBe(false);
    expect(await svc.isTrusted("fake-idp:t1x")).toBe(false);
    expect(await svc.isTrusted("idp-tenant:t1")).toBe(false);
    // trust does not depend on the login page switch (directory sync reads it too)
    expect((await svc.get("fake-idp"))?.enabled).toBe(false);
  });

  it("keeps an entry of an unloaded extension", async () => {
    await svc.update("fake-idp", { enabled: true, trustedTenants: ["t1"] }, actor);
    const host = k.app.get(ExtensionHost);
    await host.unload("fake-idp");
    try {
      expect((await svc.list()).map((e) => e.plugin)).toEqual(["fake-idp"]);
      expect(await svc.enabled()).toEqual([]);
      expect(await k.app.get(SsoFlow).sources()).toEqual([]);
      // a stored entry can still be changed while its extension is away (only blanks refused)
      expect(
        (await svc.update("fake-idp", { trustedTenants: ["t2"] }, actor)).trustedTenants,
      ).toEqual(["t2"]);
    } finally {
      await host.reload("fake-idp");
    }
    expect((await svc.enabled()).map((e) => e.plugin)).toEqual(["fake-idp"]);
  });

  it("unknown plugin is refused with login_sources.unknown_plugin", async () => {
    const err = await refused(svc.update("not-installed", { enabled: true }, actor));
    expect(err.code).toBe("login_sources.unknown_plugin");
    expect(err.status).toBe(404);
    expect(await svc.list()).toEqual([]);
  });

  it("enabling with invalid deployment config → login_sources.needs_config", async () => {
    // not loaded: the host waits for its config
    const err = await refused(svc.update("idp-unconfigured", { enabled: true }, actor));
    expect(err.code).toBe("login_sources.needs_config");
    expect(err.status).toBe(409);
    // loaded, but a required overridable field is empty on the platform
    expect(k.app.get(ExtensionHost).current("idp-org-field")).toBeDefined();
    const loaded = await refused(svc.update("idp-org-field", { enabled: true }, actor));
    expect(loaded.code).toBe("login_sources.needs_config");
    expect(await svc.list()).toEqual([]);
    // what does not turn it on is still accepted
    expect((await svc.update("idp-org-field", { signUp: "create" }, actor)).enabled).toBe(false);
  });

  it("writes audit login_sources.updated with before and after", async () => {
    await svc.update("fake-idp", { enabled: true }, actor);
    await svc.update("fake-idp", { signUp: "create" }, actor);
    const rows = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "action", "target", "detail"])
      .where("action", "=", "login_sources.updated")
      .orderBy("id")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      actor_account_id: actor,
      target: "fake-idp",
      detail: {
        before: { plugin: "fake-idp", enabled: true, signUp: "link", trustedTenants: [] },
        after: { plugin: "fake-idp", enabled: true, signUp: "create", trustedTenants: [] },
      },
    });
    expect(rows[0]?.detail).toMatchObject({ before: null });
  });

  it("an invalid stored value reads as no entries", async () => {
    await db
      .insertInto("deployment_settings")
      .values({ key: LOGIN_SOURCES_SETTING, value: JSON.stringify({ nope: true }) })
      .execute();
    expect(await svc.list()).toEqual([]);
    expect(await svc.isTrusted("fake-idp:t1")).toBe(false);
  });
});
