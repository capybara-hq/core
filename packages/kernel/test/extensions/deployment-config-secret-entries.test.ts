import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { extensionConfigSources } from "../../src/config/sources.js";
import { createKeyring, createSecrets } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

const SECRETKEYS = fileURLToPath(
  new URL("../fixtures/plugins/secretkeys/index.ts", import.meta.url),
);
const SK1 = "sk-1-Vq8mT2deepseek-secret";
const SK2 = "sk-2-Pw3nX7other-secret";
const SK3 = "sk-3-Hc5rL1third-secret";
const FILE_SECRET = "file-Kq7Zr4startup-secret";
const MASTER = Buffer.alloc(32, 7);

interface Field {
  path: string;
  secret: boolean;
  source: string;
  readonly: boolean;
  set?: boolean;
  keys?: string[];
  value?: unknown;
}

/** Secret records drawn per item: `keys` in the view, `secretEntries` on PUT (spec §4.3). */
describe("deployment config secret entries", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let db: KernelSchemaDb;
  let destroyDb: () => Promise<void>;
  let k: TestKernel | undefined;
  let admin: Req;
  const lines: string[] = [];

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
    const raw = createDb(pgc.url, 3);
    db = kernelDb(raw);
    destroyDb = () => raw.destroy();
    await truncateTables(
      db,
      "capybara.extension_deployment_configs, capybara.secrets, capybara.audit_events, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
    );
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      superAdmin: true,
    });
    const cfg = {
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: MASTER.toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api", "worker"],
      extensions: [MODEL_FAKE, SECRETKEYS],
      extensionPermissions: { autoApprove: true },
      extensionConfig: { secretkeys: { fileKeys: { a: FILE_SECRET } } },
    };
    k = await startKernel(resolveConfig(cfg, {}), {
      logger: createLogger("info", { write: (l) => lines.push(l) }),
      extensionConfigSources: extensionConfigSources(cfg, {}, "file"),
    });
    admin = await session(k, "root");
  });

  afterAll(async () => {
    await k?.close();
    await destroyDb?.();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  const URL_ = "/api/v1/admin/extensions/secretkeys/config";
  const put = (payload: Record<string, unknown>) =>
    admin({ method: "PUT", url: URL_, payload: { values: {}, ...payload } });
  const field = (body: string, path: string) =>
    (JSON.parse(body) as { fields: Field[] }).fields.find((f) => f.path === path) as Field;
  const noSecretIn = (text: string) => {
    for (const s of [SK1, SK2, SK3, FILE_SECRET]) expect(text).not.toContain(s);
  };
  const stored = async (path: string): Promise<unknown> => {
    const v = await createSecrets(db, createKeyring(MASTER, []), "kernel").get(
      "_deployment",
      `plugin-deployment-config:secretkeys:${path}`,
    );
    return v === null ? null : JSON.parse(v);
  };
  const lastAudit = async () => {
    const rows = await db
      .selectFrom("audit_events")
      .select(["detail", "id"])
      .where("action", "=", "extension.deployment_config_updated")
      .orderBy("id", "desc")
      .execute();
    return rows[0];
  };
  const ep = (...names: string[]) => names.map((name) => ({ name, baseUrl: `https://${name}` }));

  it("the view lists keys only for hinted secret records; startup-config keys are read-only", async () => {
    const res = await admin({ method: "GET", url: URL_ });
    expect(res.statusCode, res.body).toBe(200);
    noSecretIn(res.body);
    expect(field(res.body, "apiKeys")).toMatchObject({ secret: true, set: false, keys: [] });
    expect(field(res.body, "fileKeys")).toMatchObject({
      source: "file",
      readonly: true,
      set: true,
      keys: ["a"],
    });
    expect(field(res.body, "otherKeys")).not.toHaveProperty("keys");
  });

  it("set: keys in the view, set, no value in the response, the audit or the logs", async () => {
    expect((await put({ values: { endpoints: ep("deepseek") } })).statusCode).toBe(200);
    const res = await put({ secretEntries: [{ path: "apiKeys", key: "deepseek", value: SK1 }] });
    expect(res.statusCode, res.body).toBe(200);
    noSecretIn(res.body);
    expect(field(res.body, "apiKeys")).toMatchObject({
      set: true,
      source: "db",
      keys: ["deepseek"],
    });
    expect(field(res.body, "apiKeys")).not.toHaveProperty("value");
    const audit = await lastAudit();
    expect(audit?.detail).toEqual({ changedPaths: ["apiKeys"] });
    noSecretIn(JSON.stringify(audit));
    expect(await stored("apiKeys")).toEqual({ deepseek: SK1 });
    // the stored non-secret row holds no secret either
    const row = await db.selectFrom("extension_deployment_configs").selectAll().execute();
    noSecretIn(JSON.stringify(row));
    const view = await admin({ method: "GET", url: URL_ });
    expect(field(view.body, "apiKeys").keys).toEqual(["deepseek"]);
  });

  it("rename moves the value; with the endpoint renamed in the same PUT it validates", async () => {
    // renaming the key alone leaves a key naming no endpoint: invalid, nothing saved
    const alone = await put({
      secretEntries: [{ path: "apiKeys", key: "ds", renameFrom: "deepseek" }],
    });
    expect(alone.statusCode, alone.body).toBe(400);
    expect(alone.json().error.code).toBe("extension.config_invalid");
    noSecretIn(alone.body);
    expect(await stored("apiKeys")).toEqual({ deepseek: SK1 });

    const res = await put({
      values: { endpoints: ep("ds") },
      secretEntries: [{ path: "apiKeys", key: "ds", renameFrom: "deepseek" }],
    });
    expect(res.statusCode, res.body).toBe(200);
    noSecretIn(res.body);
    expect(field(res.body, "apiKeys").keys).toEqual(["ds"]);
    expect(await stored("apiKeys")).toEqual({ ds: SK1 });
    expect((await lastAudit())?.detail).toEqual({ changedPaths: ["apiKeys", "endpoints"] });
  });

  it("remove: value null drops the key", async () => {
    const res = await put({ secretEntries: [{ path: "apiKeys", key: "ds", value: null }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(field(res.body, "apiKeys")).toMatchObject({ keys: [], set: false });
    expect(await stored("apiKeys")).toBeNull();
  });

  it("a path no hint names -> 400 validation_failed; a startup-config path -> 409 config_readonly", async () => {
    const before = await db.selectFrom("extension_deployment_configs").selectAll().execute();
    for (const path of ["otherKeys", "endpoints", "nope"]) {
      const res = await put({ secretEntries: [{ path, key: "x", value: SK2 }] });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
      noSecretIn(res.body);
    }
    const ro = await put({ secretEntries: [{ path: "fileKeys", key: "a", value: SK2 }] });
    expect(ro.statusCode, ro.body).toBe(409);
    expect(ro.json().error.code).toBe("extension.config_readonly");
    noSecretIn(ro.body);
    // malformed entries: neither value nor renameFrom, a prototype key, the path also in values
    for (const payload of [
      { secretEntries: [{ path: "apiKeys", key: "x" }] },
      { secretEntries: [{ path: "apiKeys", key: "__proto__", value: SK2 }] },
      {
        values: { apiKeys: { x: SK2 } },
        secretEntries: [{ path: "apiKeys", key: "x", value: SK2 }],
      },
    ]) {
      const res = await put(payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
      noSecretIn(res.body);
    }
    expect(await db.selectFrom("extension_deployment_configs").selectAll().execute()).toEqual(
      before,
    );
    expect(await stored("otherKeys")).toBeNull();
  });

  it("two concurrent PUTs each setting a different key: both keys present", async () => {
    expect((await put({ values: { endpoints: ep("a", "b") } })).statusCode).toBe(200);
    const [r1, r2] = await Promise.all([
      put({ secretEntries: [{ path: "apiKeys", key: "a", value: SK2 }] }),
      put({ secretEntries: [{ path: "apiKeys", key: "b", value: SK3 }] }),
    ]);
    expect(r1?.statusCode, r1?.body).toBe(200);
    expect(r2?.statusCode, r2?.body).toBe(200);
    expect(await stored("apiKeys")).toEqual({ a: SK2, b: SK3 });
    const view = await admin({ method: "GET", url: URL_ });
    expect(field(view.body, "apiKeys").keys).toEqual(["a", "b"]);
  });

  it("an unhinted secret record still reports only set", async () => {
    const res = await put({ values: { otherKeys: { x: SK2 } } });
    expect(res.statusCode, res.body).toBe(200);
    noSecretIn(res.body);
    const f = field(res.body, "otherKeys");
    expect(f).toMatchObject({ secret: true, set: true });
    expect(f).not.toHaveProperty("keys");
  });

  it("no secret value in any log line", () => {
    noSecretIn(lines.join("\n"));
  });
});
