import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { extensionConfigSources } from "../../src/config/sources.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Org levels on deployment schemas real plugins write (spec A §5.2, §5.4a): an object-level
 * refinement across fields (`orgrefined`) and an overridable field wrapped in `.default()` after
 * `orgAccess` (`orgwrapped`).
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: Req;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  await truncateTables(db, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true });
  await accounts.createLocal({ login: "owner", password: PW, displayName: "O" });
  const cfg = {
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api", "worker"],
    extensions: [fx("orgrefined"), fx("orgwrapped")],
    extensionPermissions: { autoApprove: true },
    // the platform leaves orgrefined's overridable endpoint empty; the refinement reads it
    extensionConfig: { orgrefined: { mode: "strict" }, orgwrapped: { host: "h" } },
  };
  k = await startKernel(resolveConfig(cfg, {}), {
    env: {},
    logger: createLogger("error", { write: () => {} }),
    extensionConfigSources: extensionConfigSources(cfg, {}, "file"),
  });
  root = await session(k, "root");
  owner = await session(k, "owner");
  orgId = await createOrg(owner, "Acme");
  await enableExtensions(db, orgId, "orgrefined", "orgwrapped");
}, 240_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const host = () => k.app.get(ExtensionHost);
const effective = () => k.app.get(EffectiveConfigs);
const adminUrl = (p: string) => `/api/v1/admin/extensions/${p}/config`;
const ovUrl = (p: string) => `/api/v1/orgs/${orgId}/extensions/${p}/overrides`;

describe("a refined deployment schema", () => {
  it("loads with the overridable field empty; following orgs must configure it", async () => {
    expect(host().current("orgrefined")?.config).toEqual({ mode: "strict" });
    expect(await effective().get(orgId, "orgrefined")).toEqual({
      ok: false,
      issues: [
        {
          path: "endpoint",
          segments: ["endpoint"],
          message: "required: the platform leaves it empty",
        },
      ],
    });
    const view = await root({ method: "GET", url: adminUrl("orgrefined") });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ valid: true, orgMustConfigure: ["endpoint"] });
  });

  it("a complete platform config is checked with the refinement", async () => {
    const bad = await root({
      method: "PUT",
      url: adminUrl("orgrefined"),
      payload: { values: { endpoint: "http://p.example" } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: "extension.config_invalid",
      details: [{ path: "endpoint" }],
    });
    const good = await root({
      method: "PUT",
      url: adminUrl("orgrefined"),
      payload: { values: { endpoint: "https://p.example" } },
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(host().current("orgrefined")?.config).toEqual({
      mode: "strict",
      endpoint: "https://p.example",
    });
    expect(await effective().get(orgId, "orgrefined")).toMatchObject({
      ok: true,
      source: "platform",
    });
    // back to empty: the load gate relaxes it again
    const cleared = await root({
      method: "PUT",
      url: adminUrl("orgrefined"),
      payload: { values: { endpoint: null } },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(host().current("orgrefined")?.config).toEqual({ mode: "strict" });
  });

  it("an org copy is validated with the refinement", async () => {
    const bad = await owner({
      method: "PUT",
      url: ovUrl("orgrefined"),
      payload: { values: { endpoint: "http://org.example" } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: "extension.config_invalid",
      details: [{ path: "endpoint" }],
    });
    const good = await owner({
      method: "PUT",
      url: ovUrl("orgrefined"),
      payload: { values: { endpoint: "https://org.example" } },
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(await effective().get(orgId, "orgrefined")).toEqual({
      ok: true,
      source: "copy",
      config: { mode: "strict", endpoint: "https://org.example" },
    });
  });
});

describe("an overridable field wrapped in .default()", () => {
  it("is overridable end to end: the org view lists it and a save is accepted", async () => {
    const view = await owner({ method: "GET", url: ovUrl("orgwrapped") });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().fields).toEqual([
      { path: "region", level: "override", secret: false, platform: { value: "eu" } },
    ]);
    const saved = await owner({
      method: "PUT",
      url: ovUrl("orgwrapped"),
      payload: { values: { region: "us" } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await effective().get(orgId, "orgwrapped")).toEqual({
      ok: true,
      source: "copy",
      config: { host: "h", region: "us" },
    });
  });
});
