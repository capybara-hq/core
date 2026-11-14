import { fileURLToPath } from "node:url";
import {
  defineExtension,
  type ExtensionManifest,
  ExtensionPermissionError,
  type SetupCheckDefinition,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createExtensionContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import {
  blockingKeys,
  buildPermissionSet,
  diffPermissions,
  permissionKeys,
} from "../../src/extensions/permission-set.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import { waitFor } from "../helpers/runs.js";

// ctx.setup.check (setup guides v2 §10.2, the T7 review's T10 requirements): only during setup,
// only ids declared in permissions.setupChecks (else ExtensionPermissionError and an audit row),
// a duplicate throws, place and run checked and read once; setupCheck ids are recorded in the
// permission snapshot without blocking loading.

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    locks: new LockService(redis, createLogger("error")),
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    embedTokens: new EmbedTokens(createKeyring(Buffer.alloc(32, 1), [])),
    hooks: undefined,
    runWorkers: false,
    log: quiet,
  };
});

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

const mf = (name: string, setupChecks?: string[]): ExtensionManifest =>
  defineExtension({
    name,
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    permissions: setupChecks === undefined ? {} : { setupChecks },
    setup() {},
  });

const def: SetupCheckDefinition = {
  place: "channel-connection",
  run: async () => ({ status: "ok" }),
};

describe("ctx.setup.check registration", () => {
  it("registers a declared id (the throwing placeholder is gone)", async () => {
    const ctx = createExtensionContext(deps, mf("chk-a", ["bot-token"]), {});
    ctx.setup.check("bot-token", def);
    expect([...ctx.setupChecks.keys()]).toEqual(["bot-token"]);
    const reg = ctx.setupChecks.get("bot-token");
    expect(reg?.place).toBe("channel-connection");
    expect(Object.isFrozen(reg)).toBe(true);
    await expect(reg?.run({} as never)).resolves.toEqual({ status: "ok" });
    await ctx.close();
    // revoked with the instance
    expect(ctx.setupChecks.size).toBe(0);
  });

  it("check outside setup throws", async () => {
    const ctx = createExtensionContext(deps, mf("chk-b", ["bot-token"]), {});
    ctx.sealTools();
    expect(() => ctx.setup.check("bot-token", def)).toThrow(/only allowed during setup/);
    expect(ctx.setupChecks.size).toBe(0);
    await ctx.close();
  });

  it("undeclared or malformed id throws ExtensionPermissionError and audits", async () => {
    const ctx = createExtensionContext(deps, mf("chk-c", ["bot-token"]), {});
    expect(() => ctx.setup.check("other", def)).toThrow(ExtensionPermissionError);
    expect(() => ctx.setup.check("other", def)).toThrow(/permissions\.setupChecks other/);
    // a kernel id can never be registered by an extension
    expect(() => ctx.setup.check("capybara:public-url", def)).toThrow(ExtensionPermissionError);
    expect(() => ctx.setup.check("Bad Id", def)).toThrow(/\(invalid id\)/);
    expect(() => ctx.setup.check(42 as unknown as string, def)).toThrow(ExtensionPermissionError);
    expect(ctx.setupChecks.size).toBe(0);
    const rows = await waitFor(async () => {
      const r = await kernelDb(deps.db)
        .selectFrom("audit_events")
        .select("detail")
        .where("action", "=", "extension.permission_denied")
        .where("target", "=", "chk-c")
        .execute();
      return r.length >= 2 ? r : undefined;
    });
    const items = rows.map((r) => (r.detail as { item: string }).item).sort();
    expect(items).toEqual([
      "permissions.setupChecks (invalid id)",
      "permissions.setupChecks other",
    ]);
    await ctx.close();
  });

  it("duplicate throws", async () => {
    const ctx = createExtensionContext(deps, mf("chk-d", ["bot-token"]), {});
    ctx.setup.check("bot-token", def);
    expect(() => ctx.setup.check("bot-token", def)).toThrow(/duplicate setup check "bot-token"/);
    await ctx.close();
  });

  it("an unknown place or a run that is not a function throws; place and run are read once", async () => {
    const ctx = createExtensionContext(deps, mf("chk-e", ["a", "b", "c", "d"]), {});
    expect(() => ctx.setup.check("a", { ...def, place: "nowhere" as never })).toThrow(/place/);
    expect(() => ctx.setup.check("b", { place: "channel-connection" } as never)).toThrow(/run/);
    expect(() => ctx.setup.check("c", null as never)).toThrow(/definition/);
    let reads = 0;
    const sneaky = {
      get place() {
        reads += 1;
        return reads === 1 ? "channel-connection" : "connector-template";
      },
      run: def.run,
    } as SetupCheckDefinition;
    ctx.setup.check("d", sneaky);
    expect(ctx.setupChecks.get("d")?.place).toBe("channel-connection");
    expect(ctx.setupChecks.get("d")?.place).toBe("channel-connection");
    expect(reads).toBe(1);
    await ctx.close();
  });
});

describe("setupCheck ids in the permission snapshot", () => {
  const set = (setupChecks?: string[]) =>
    buildPermissionSet({
      provides: [],
      config: { deployment: [], org: [] },
      tables: [],
      permissions: mf("chk-snap", setupChecks).permissions,
    });

  it("records the ids and an added id does not block loading", () => {
    const before = set(["bot-token"]);
    const after = set(["bot-token", "webhook"]);
    expect(before.permissions.setupChecks).toEqual(["bot-token"]);
    expect(permissionKeys(after)).toEqual(
      expect.arrayContaining(["setup.check:bot-token", "setup.check:webhook"]),
    );
    const d = diffPermissions(before, after);
    expect(d.added).toEqual(["setup.check:webhook"]);
    expect(blockingKeys(d.added)).toEqual([]);
  });

  it("a plugin without setup checks keeps its snapshot shape", () => {
    expect(set().permissions).not.toHaveProperty("setupChecks");
  });
});
