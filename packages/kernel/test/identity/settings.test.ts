import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import {
  COMPACTION_SETTINGS,
  DEPLOYMENT_SETTINGS,
  type DeploymentSettingsPatch,
  parseClientExtensions,
  readClientExtensions,
  SettingsService,
} from "../../src/identity/settings.js";
import { HTML_CDN_ALLOWLIST_DEFAULT } from "../../src/shares/settings.js";
import {
  accountsFor,
  adminLockFor,
  ceilingWritesFor,
  handlesFor,
  settingsFor,
} from "../helpers/identity.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 5);
  db = kernelDb(raw);
});
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});

describe("SettingsService", () => {
  it("默认 anyone；更新后读到新值；非法值抛 validation_failed", async () => {
    const s = settingsFor(db);
    const admin = await accountsFor(db).createLocal({
      login: "root",
      password: "correct horse battery",
      displayName: "R",
      superAdmin: true,
    });
    expect((await s.get()).orgCreation).toBe("anyone");
    expect((await s.update({ orgCreation: "super_admin" }, admin.id)).orgCreation).toBe(
      "super_admin",
    );
    expect((await s.get()).orgCreation).toBe("super_admin");
    try {
      // biome-ignore lint/suspicious/noExplicitAny: 故意传非法值
      await s.update({ orgCreation: "nobody" as any }, admin.id);
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).code).toBe("validation_failed");
    }
  });

  it("逐键校验：表里非法的 orgCreation 回落默认值并 warn 点名该键；未知的未来键不影响其他键", async () => {
    await db.deleteFrom("deployment_settings").execute();
    await db
      .insertInto("deployment_settings")
      .values([
        { key: "orgCreation", value: JSON.stringify("nobody") },
        { key: "futureKey", value: JSON.stringify({ enabled: true }) },
      ])
      .execute();
    const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      info: () => {},
      error: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) =>
        warns.push({ msg, ...(fields && { fields }) }),
    };
    const s = settingsFor(db, log);
    expect(await s.get()).toEqual({
      orgCreation: "anyone",
      runConcurrencyOverrides: {},
      uiArrangement: {},
      priceCurrency: "USD",
      sandboxLimitOverrides: {},
      subagentLimitOverrides: {},
      customConnectors: "allow",
      customSkills: "allow",
      orgMarketplaceBrowse: true,
      uiTheme: { id: null },
      clientExtensions: { enabled: true, disabled: [] },
      compaction: {
        enabled: true,
        threshold: 0.8,
        keepRecentTurns: 4,
        reserveTokens: 8000,
        maxOutputTokens: 20_000,
      },
      htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT],
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ key: "orgCreation" });
  });

  it("逐键校验：合法的键保留（另一个键非法不会丢掉它）", async () => {
    await db.deleteFrom("deployment_settings").execute();
    await db
      .insertInto("deployment_settings")
      .values({ key: "orgCreation", value: JSON.stringify("super_admin") })
      .execute();
    const warns: string[] = [];
    const s = settingsFor(db, { warn: (msg) => warns.push(msg) });
    expect((await s.get()).orgCreation).toBe("super_admin");
    expect(warns).toEqual([]);
  });

  it("sandboxLimitOverrides 按组织合并（整项替换，null 删除）；customConnectors / customSkills；审计", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const s = settingsFor(db);
    const admin = await accountsFor(db).createLocal({
      login: "limits-admin",
      password: "correct horse battery",
      displayName: "L",
      superAdmin: true,
    });
    const r1 = await s.update(
      { sandboxLimitOverrides: { orgA: { cpu: 2, memoryMb: 4096 }, orgB: { cpu: 0.25 } } },
      admin.id,
    );
    expect(r1.sandboxLimitOverrides).toEqual({
      orgA: { cpu: 2, memoryMb: 4096 },
      orgB: { cpu: 0.25 },
    });
    // 只改列出的组织；给出的组织整项替换；null 删除；其他键不受影响
    const r2 = await s.update(
      {
        sandboxLimitOverrides: { orgA: { memoryMb: 262144 }, orgB: null, orgC: { cpu: 64 } },
        customConnectors: "deny",
      },
      admin.id,
    );
    expect(r2).toMatchObject({
      sandboxLimitOverrides: { orgA: { memoryMb: 262144 }, orgC: { cpu: 64 } },
      customConnectors: "deny",
      customSkills: "allow",
      orgCreation: "anyone",
    });
    expect((await s.update({ customSkills: "deny" }, admin.id)).customSkills).toBe("deny");
    expect((await s.get()).sandboxLimitOverrides).toEqual({
      orgA: { memoryMb: 262144 },
      orgC: { cpu: 64 },
    });
    const ev = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "deployment.settings.updated")
      .where("actor_account_id", "=", admin.id)
      .orderBy("id")
      .execute();
    expect(ev.map((e) => e.detail)).toContainEqual({
      sandboxLimitOverrides: { orgA: { memoryMb: 262144 }, orgB: null, orgC: { cpu: 64 } },
      customConnectors: "deny",
    });
  });

  it("sandboxLimitOverrides 越界 / 非整数 / 空项与 customSkills 非法值 → validation_failed，库不变", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const s = settingsFor(db);
    const admin = await accountsFor(db).createLocal({
      login: "limits-admin-2",
      password: "correct horse battery",
      displayName: "L2",
      superAdmin: true,
    });
    for (const patch of [
      { sandboxLimitOverrides: { orgA: { cpu: 0.2 } } },
      { sandboxLimitOverrides: { orgA: { cpu: 64.5 } } },
      { sandboxLimitOverrides: { orgA: { memoryMb: 255 } } },
      { sandboxLimitOverrides: { orgA: { memoryMb: 262145 } } },
      { sandboxLimitOverrides: { orgA: { memoryMb: 512.5 } } },
      { sandboxLimitOverrides: { orgA: {} } },
      { sandboxLimitOverrides: { orgA: { cpu: 1, gpu: 1 } } },
      { customSkills: "maybe" },
    ]) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: 故意传非法值
        await s.update(patch as any, admin.id);
        expect.unreachable(JSON.stringify(patch));
      } catch (e) {
        expect((e as ApiError).code, JSON.stringify(patch)).toBe("validation_failed");
      }
    }
    expect(await db.selectFrom("deployment_settings").selectAll().execute()).toEqual([]);
  });

  it("clientExtensions: each given field replaces the stored one; disabled is stored sorted once; invalid input is refused", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const s = settingsFor(db);
    const admin = await accountsFor(db).createLocal({
      login: "client-kill-admin",
      password: "correct horse battery",
      displayName: "K",
      superAdmin: true,
    });
    expect((await s.get()).clientExtensions).toEqual({ enabled: true, disabled: [] });
    expect(await readClientExtensions(db)).toEqual({ enabled: true, disabled: [] });
    const r1 = await s.update(
      { clientExtensions: { disabled: ["b-ext", "a-ext", "b-ext"] } },
      admin.id,
    );
    expect(r1.clientExtensions).toEqual({ enabled: true, disabled: ["a-ext", "b-ext"] });
    const r2 = await s.update({ clientExtensions: { enabled: false } }, admin.id);
    expect(r2.clientExtensions).toEqual({ enabled: false, disabled: ["a-ext", "b-ext"] });
    expect(await readClientExtensions(db)).toEqual({
      enabled: false,
      disabled: ["a-ext", "b-ext"],
    });
    for (const patch of [
      { clientExtensions: {} },
      { clientExtensions: { disabled: ["Not A Name"] } },
      { clientExtensions: { enabled: "no" } },
      { clientExtensions: { enabled: true, other: 1 } },
      { clientExtensions: { disabled: Array.from({ length: 201 }, (_, i) => `ext-${i}`) } },
    ]) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: invalid on purpose
        await s.update(patch as any, admin.id);
        expect.unreachable(JSON.stringify(patch).slice(0, 80));
      } catch (e) {
        expect((e as ApiError).code, JSON.stringify(patch).slice(0, 80)).toBe("validation_failed");
      }
    }
    // an invalid stored value reads as everything on
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ enabled: "x" }) })
      .where("key", "=", "clientExtensions")
      .execute();
    const warned: Record<string, unknown>[] = [];
    const log = {
      warn: (_msg: string, fields?: Record<string, unknown>) => warned.push(fields ?? {}),
    };
    expect(await readClientExtensions(db, log)).toEqual({ enabled: true, disabled: [] });
    expect(warned).toEqual([{ key: "clientExtensions", issues: expect.any(Array) }]);
    // a missing row is the default, without a warning
    expect(parseClientExtensions(undefined, log)).toEqual({ enabled: true, disabled: [] });
    expect(warned).toHaveLength(1);
  });

  it("读：库里非法的 sandboxLimitOverrides 回落为 {}", async () => {
    await db.deleteFrom("deployment_settings").execute();
    await db
      .insertInto("deployment_settings")
      .values({ key: "sandboxLimitOverrides", value: JSON.stringify({ orgA: { cpu: 999 } }) })
      .execute();
    const warns: string[] = [];
    const s = settingsFor(db, { warn: (msg) => warns.push(msg) });
    expect((await s.get()).sandboxLimitOverrides).toEqual({});
    expect(warns).toHaveLength(1);
  });

  it("compaction: built-in defaults, a patch merges only the fields it gives, ranges are enforced", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const defaults = COMPACTION_SETTINGS.parse({});
    expect(DEPLOYMENT_SETTINGS.parse({}).compaction).toEqual(defaults);
    const s = settingsFor(db);
    const admin = await accountsFor(db).createLocal({
      login: "compaction-admin",
      password: "correct horse battery",
      displayName: "C",
      superAdmin: true,
    });
    const r1 = await s.update({ compaction: { threshold: 0.6 } }, admin.id);
    expect(r1.compaction).toEqual({ ...defaults, threshold: 0.6 });
    // a later patch changes only the fields it gives; the stored threshold stays
    const r2 = await s.update({ compaction: { keepRecentTurns: 2 } }, admin.id);
    expect(r2.compaction).toEqual({ ...defaults, threshold: 0.6, keepRecentTurns: 2 });
    expect((await s.get()).compaction).toEqual(r2.compaction);
    for (const patch of [
      { compaction: { threshold: 0.99 } },
      { compaction: { threshold: 0.49 } },
      { compaction: { keepRecentTurns: 21 } },
      { compaction: { reserveTokens: 50_001 } },
      { compaction: { maxOutputTokens: 1023 } },
      { compaction: { enabled: "yes" } },
      { compaction: { other: true } },
    ]) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: invalid on purpose
        await s.update(patch as any, admin.id);
        expect.unreachable(JSON.stringify(patch));
      } catch (e) {
        expect((e as ApiError).code, JSON.stringify(patch)).toBe("validation_failed");
      }
    }
  });

  it("runtime no longer carries the two compaction fields", () => {
    const config = KernelConfigSchema.parse({
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(config.runtime).not.toHaveProperty("compactionThreshold");
    expect(config.runtime).not.toHaveProperty("keepRecentTurns");
  });
});

describe("SettingsService devicesOutsideSandbox and devicesNetwork", () => {
  type Devices = {
    outsideSandbox?: "allowed" | "off";
    network?: { default?: "open" | "allowlist"; ceiling?: "open" | "allowlist" };
  };
  /** The settings service over a config whose device sandbox fields come from `source`. */
  const serviceWith = (devices: Devices, source: "env" | "file" | "nacos" | undefined) => {
    const h = handlesFor(db);
    const valueAt = (path: string) =>
      path === "devices.outsideSandbox"
        ? devices.outsideSandbox
        : path === "devices.network.default"
          ? devices.network?.default
          : path === "devices.network.ceiling"
            ? devices.network?.ceiling
            : undefined;
    return new SettingsService(
      h.db,
      h.txHost,
      adminLockFor(db),
      { warn: () => {} },
      {
        get: () =>
          ({
            devices: { outsideSandbox: devices.outsideSandbox, network: { ...devices.network } },
            attribution: {},
            sharing: {},
          }) as never,
        fieldSource: (path: string) => (valueAt(path) === undefined ? undefined : source),
      },
      ceilingWritesFor(db),
    );
  };

  const adminFor = (login: string) =>
    accountsFor(db).createLocal({
      login,
      password: "correct horse battery",
      displayName: login,
      superAdmin: true,
    });

  it("view reports the startup source; a write to a startup-config value is read-only", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const admin = await adminFor("outside-readonly");
    for (const source of ["env", "file", "nacos"] as const) {
      const s = serviceWith({ outsideSandbox: "off", network: { ceiling: "allowlist" } }, source);
      expect(await s.view()).toMatchObject({
        devicesOutsideSandbox: { permission: "off", source },
        devicesNetwork: {
          default: "allowlist",
          ceiling: "allowlist",
          sources: { default: "default", ceiling: source },
        },
      });
      for (const [patch, path] of [
        [
          { devicesOutsideSandbox: { permission: "allowed" as const } },
          "devicesOutsideSandbox.permission",
        ],
        [{ devicesOutsideSandbox: { permission: null } }, "devicesOutsideSandbox.permission"],
        [{ devicesNetwork: { ceiling: "open" as const } }, "devicesNetwork.ceiling"],
      ] as const) {
        const err = await s.update(patch, admin.id).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "deployment.setting_readonly" });
        expect((err as ApiError).details).toEqual([{ path, source }]);
      }
    }
  });

  it("the stored choice applies with source db; a token may turn it off, never allow it", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const admin = await adminFor("outside-token");
    const s = serviceWith({}, undefined);
    expect((await s.view()).devicesOutsideSandbox).toEqual({
      permission: "allowed",
      source: "default",
    });
    expect(
      await s.update({ devicesOutsideSandbox: { permission: "off" } }, admin.id),
    ).toMatchObject({ devicesOutsideSandbox: { permission: "off", source: "db" } });
    for (const patch of [
      { devicesOutsideSandbox: { permission: "allowed" as const } },
      { devicesOutsideSandbox: { permission: null } },
    ]) {
      const widened = await s
        .update(patch, admin.id, "tok", undefined, { onlyNarrows: true })
        .catch((e: unknown) => e);
      expect(widened).toMatchObject({ code: "deployment.outside_sandbox_not_allowed" });
    }
    // a person in a session may allow it again; null clears back to the default
    expect(
      await s.update({ devicesOutsideSandbox: { permission: "allowed" } }, admin.id),
    ).toMatchObject({ devicesOutsideSandbox: { permission: "allowed", source: "db" } });
    expect(await s.update({ devicesOutsideSandbox: { permission: null } }, admin.id)).toMatchObject(
      { devicesOutsideSandbox: { permission: "allowed", source: "default" } },
    );
    const row = await db
      .selectFrom("deployment_settings")
      .select(["key", "value"])
      .where("key", "in", ["devicesOutsideSandbox", "devicesFullAccess", "devicesAutoMode"])
      .execute();
    expect(row).toEqual([{ key: "devicesOutsideSandbox", value: {} }]);
  });

  it("the network: a default above the ceiling is refused; a token may only narrow", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const admin = await adminFor("network-token");
    const s = serviceWith({}, undefined);
    expect(
      await s.update({ devicesNetwork: { ceiling: "allowlist", default: "allowlist" } }, admin.id),
    ).toMatchObject({
      devicesNetwork: {
        default: "allowlist",
        ceiling: "allowlist",
        sources: { default: "db", ceiling: "db" },
      },
    });
    // the default above the ceiling, by a person too
    const above = await s
      .update({ devicesNetwork: { default: "open" } }, admin.id)
      .catch((e: unknown) => e);
    expect(above).toMatchObject({ code: "deployment.network_not_allowed", status: 400 });
    // a narrowing is never refused: the ceiling under a stored open default (the reader clamps)
    await s.update({ devicesNetwork: { default: null, ceiling: null } }, admin.id);
    await s.update({ devicesNetwork: { default: "open" } }, admin.id);
    expect(await s.update({ devicesNetwork: { ceiling: "allowlist" } }, admin.id)).toMatchObject({
      devicesNetwork: { default: "allowlist", ceiling: "allowlist" },
    });
    // across sources the reader clamps too: an open stored default under a configured ceiling
    await s.update({ devicesNetwork: { default: null, ceiling: null } }, admin.id);
    const configured = serviceWith({ network: { ceiling: "allowlist" } }, "file");
    expect(
      await configured.update({ devicesNetwork: { default: "open" } }, admin.id),
    ).toMatchObject({ devicesNetwork: { default: "allowlist", ceiling: "allowlist" } });
    await s.update({ devicesNetwork: { default: "allowlist", ceiling: "allowlist" } }, admin.id);
    // a token may not open either field, nor clear it back to open
    for (const devicesNetwork of [
      { ceiling: "open" as const },
      { ceiling: null },
      { ceiling: "open" as const, default: "open" as const },
    ]) {
      const widened = await s
        .update({ devicesNetwork }, admin.id, "tok", undefined, { onlyNarrows: true })
        .catch((e: unknown) => e);
      expect(widened).toMatchObject({ code: "deployment.network_not_allowed" });
    }
    // a person opens both in one change
    expect(
      await s.update({ devicesNetwork: { ceiling: "open", default: "open" } }, admin.id),
    ).toMatchObject({ devicesNetwork: { default: "open", ceiling: "open" } });
    // and a token narrows
    expect(
      await s.update({ devicesNetwork: { default: "allowlist" } }, admin.id, "tok", undefined, {
        onlyNarrows: true,
      }),
    ).toMatchObject({ devicesNetwork: { default: "allowlist", ceiling: "open" } });
  });

  it("a change the startup config hides is no widening: no consent reset, the audit says so", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const admin = await adminFor("network-hidden");
    const s = serviceWith({ network: { ceiling: "allowlist" } }, "file");
    const epoch = async () => {
      const row = await db
        .selectFrom("permission_authority_epochs")
        .select(["revision", "full_revision"])
        .where("kind", "=", "platform")
        .executeTakeFirst();
      return { revision: row?.revision ?? 0, full: row?.full_revision ?? 0 };
    };
    const before = await epoch();
    await s.update({ devicesNetwork: { default: "open" } }, admin.id);
    expect(await epoch()).toEqual(before);
    const audit = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "deployment.settings.updated")
      .orderBy("at", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      deviceSandboxEffective: {
        before: { network: { default: "allowlist", ceiling: "allowlist" } },
        after: { network: { default: "allowlist", ceiling: "allowlist" } },
      },
    });
  });

  it("the old names are refused and never answered", async () => {
    await db.deleteFrom("deployment_settings").execute();
    const admin = await adminFor("outside-legacy");
    const s = serviceWith({}, undefined);
    for (const patch of [
      { devicesAutoMode: { mode: "off" } },
      { devicesFullAccess: { permission: "off" } },
      { devicesFullAccess: { permission: "off" }, devicesOutsideSandbox: { permission: "off" } },
    ]) {
      const err = await s
        .update(patch as unknown as DeploymentSettingsPatch, admin.id)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "validation_failed" });
    }
    expect(
      await db
        .selectFrom("deployment_settings")
        .select("key")
        .where("key", "in", ["devicesOutsideSandbox", "devicesFullAccess", "devicesAutoMode"])
        .execute(),
    ).toEqual([]);
    expect(await s.view()).not.toHaveProperty("devicesAutoMode");
    expect(await s.view()).not.toHaveProperty("devicesFullAccess");
  });
});
