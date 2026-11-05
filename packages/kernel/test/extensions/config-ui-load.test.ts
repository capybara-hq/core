import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { createOrg, PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

const BADHINTS = fileURLToPath(new URL("../fixtures/plugins/badhints/index.ts", import.meta.url));
const THROWHINTS = fileURLToPath(
  new URL("../fixtures/plugins/throwhints/index.ts", import.meta.url),
);
const CHAN_THROWHINTS = fileURLToPath(
  new URL("../fixtures/plugins/chan-throwhints/index.ts", import.meta.url),
);

type Schema = { properties: Record<string, Record<string, unknown>>; "x-ui"?: unknown };

/** Config UI hints in the kernel (extension config forms spec §4.1, §4.4, §4.5). */
describe("config UI hints: load-time validation, static schemas, issue message keys", {
  timeout: 120_000,
}, () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let db: KernelSchemaDb;
  let destroyDb: () => Promise<void>;
  let k: TestKernel | undefined;
  let admin: Req;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const raw = createDb(pgc.url, 3);
    db = kernelDb(raw);
    destroyDb = () => raw.destroy();
    await truncateTables(
      db,
      "capybara.extension_installs, capybara.extension_packages, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
    );
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    k = await startKernel(
      resolveConfig(
        {
          db: { url: pgc.url, poolMax: 5 },
          redis: { url: rd.url },
          masterKey: Buffer.alloc(32, 7).toString("base64"),
          marketplaces: { official: { enabled: false } },
          http: { port: 0 },
          roles: ["api", "worker"],
          extensions: [MODEL_FAKE, BADHINTS, THROWHINTS, CHAN_THROWHINTS],
          extensionPermissions: { autoApprove: true },
        },
        {},
      ),
      {
        logger: createLogger("info", {
          write: (l) => {
            try {
              logs.push(JSON.parse(l) as Record<string, unknown>);
            } catch {}
          },
        }),
      },
    );
    admin = await session(k, "root");
  }, 240_000);

  afterAll(async () => {
    await k?.close();
    await destroyDb?.();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  const configView = async (plugin: string) => {
    const res = await admin({ method: "GET", url: `/api/v1/admin/extensions/${plugin}/config` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { schema: Schema | null; validated: boolean; valid: boolean };
  };

  it("invalid deployment hints: the extension loads, its schema has no x-ui, one warning, a status detail", async () => {
    const rows = await db
      .selectFrom("extension_replica_status")
      .select(["state", "detail"])
      .where("plugin", "=", "badhints")
      .execute();
    expect(rows.map((r) => r.state)).toEqual(["loaded"]);
    expect(rows[0]?.detail).toMatch(/hints/);
    expect(rows[0]?.detail).toMatch(/mode/);
    const v = await configView("badhints");
    expect(v.validated).toBe(true);
    expect(JSON.stringify(v.schema)).not.toContain("x-ui");
    expect(v.schema?.properties.greeting?.["x-hot"]).toBe(true);
    const warnings = logs.filter(
      (l) => l.plugin === "badhints" && typeof l.msg === "string" && /hints/.test(l.msg),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", version: "0.3.0" });
  });

  it("a hint check that throws: the extension still loads with a status row, a warning, a detail", async () => {
    const rows = await db
      .selectFrom("extension_replica_status")
      .select(["state", "detail"])
      .where("plugin", "=", "throwhints")
      .execute();
    expect(rows.map((r) => r.state)).toEqual(["loaded"]);
    expect(rows[0]?.detail).toMatch(/could not be checked/);
    const warnings = logs.filter(
      (l) => l.plugin === "throwhints" && typeof l.msg === "string" && /hints/.test(l.msg),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn" });
  });

  it("a hint conversion that throws: the deployment config view still renders, without a schema", async () => {
    const before = logs.length;
    for (let i = 0; i < 2; i++) {
      const v = await configView("throwhints");
      expect(v.schema).toBeNull();
      expect(v.validated).toBe(true);
      expect(v.valid).toBe(true);
    }
    // one warning per schema, not one per view
    const warnings = logs
      .slice(before)
      .filter((l) => l.plugin === "throwhints" && l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/form schema/);
  });

  it("a hint conversion that throws: the org list, the org config refusal and the channel schema still answer", async () => {
    const before = logs.length;
    const orgId = await createOrg(admin, "Throw");
    for (let i = 0; i < 2; i++) {
      const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
      expect(list.statusCode, list.body).toBe(200);
      const exts = (
        list.json() as {
          extensions: { plugin: string; configurable: boolean; orgConfigSchema: unknown }[];
        }
      ).extensions;
      // the other extensions are still listed; this one has no form schema
      expect(exts.some((e) => e.plugin === "badhints")).toBe(true);
      expect(exts.find((e) => e.plugin === "throwhints")).toMatchObject({
        configurable: true,
        orgConfigSchema: null,
      });
    }
    // a refused org config still names its issues (the messages path never throws)
    const bad = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/throwhints`,
      payload: { enabled: true, config: { team: 5 } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "extension.config_invalid" } });
    // the channel connection schema: an empty object schema, never a 500
    for (let i = 0; i < 2; i++) {
      const res = await admin({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/channels/schema/chan-throwhints`,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ plugin: "chan-throwhints", schema: { type: "object" } });
    }
    const on = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/chan-throwhints`,
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    const refused = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: { plugin: "chan-throwhints", name: "x", agentId: "none", config: {} },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: "extension.config_invalid" } });
    // one warning per schema and level, not one per request
    const warned = logs.slice(before).filter((l) => l.level === "warn");
    expect(warned.filter((l) => l.plugin === "throwhints")).toHaveLength(1);
    expect(warned.filter((l) => l.plugin === "throwhints")[0]?.msg).toMatch(/org config form/);
    expect(warned.filter((l) => l.plugin === "chan-throwhints")).toHaveLength(1);
    expect(warned.filter((l) => l.plugin === "chan-throwhints")[0]?.msg).toMatch(/connection/);
  });

  it("valid org hints pass through (x-ui, x-hot); a custom issue names its message key", async () => {
    const orgId = await createOrg(admin);
    const list = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/extensions` });
    expect(list.statusCode, list.body).toBe(200);
    const ext = (
      list.json() as { extensions: { plugin: string; orgConfigSchema: Schema | null }[] }
    ).extensions.find((e) => e.plugin === "badhints");
    expect(ext?.orgConfigSchema?.["x-ui"]).toMatchObject({
      messages: { taken: { en: "Already taken" } },
    });
    expect(ext?.orgConfigSchema?.properties.team).toMatchObject({
      "x-hot": true,
      "x-ui": { label: { en: "Team" } },
    });
    const bad = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/badhints`,
      payload: { enabled: true, config: { team: "taken" } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json()).toMatchObject({
      error: {
        code: "extension.config_invalid",
        details: [{ path: "", segments: [], messageKey: "taken" }],
      },
    });
  });

  it("an unloaded install record: the package's configSchemas.deployment as schema (validated false); without it, schema null", async () => {
    const hinted = {
      type: "object",
      properties: { mode: { type: "string", "x-ui": { label: { zh: "模式", en: "Mode" } } } },
    };
    for (const [name, sha, configSchemas] of [
      ["static-hints", "a".repeat(64), { deployment: hinted }],
      ["static-flat", "b".repeat(64), undefined],
    ] as const) {
      await db
        .insertInto("extension_packages")
        .values({
          sha256: sha,
          name,
          package_name: `@test/plugin-${name}`,
          version: "1.0.0",
          size: 1,
          section: JSON.stringify({
            entry: "./dist/index.mjs",
            manifest: {
              name,
              version: "1.0.0",
              sdk: "^0.1.0-rc.0",
              provides: [],
              requires: [],
              optional: [],
              permissions: {},
              config: { deployment: [{ path: "mode", secret: false, hot: false }] },
            },
            ...(configSchemas && { configSchemas }),
          }),
          blob_store: "pg",
          source: "file",
          source_ref: "upload",
        })
        .execute();
      await db
        .insertInto("extension_installs")
        .values({ name, sha256: sha, version: "1.0.0", source: "file", desired_state: "disabled" })
        .execute();
    }
    expect(await configView("static-hints")).toMatchObject({
      schema: hinted,
      validated: false,
      valid: true,
    });
    const flat = await configView("static-flat");
    expect(flat).toMatchObject({ schema: null, validated: false });
  });
});
