import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { SettingsService } from "../../src/identity/settings.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 5);
  db = kernelDb(raw);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});

describe("SettingsService", () => {
  it("默认 anyone；更新后读到新值；非法值抛 validation_failed", async () => {
    const s = new SettingsService(db);
    const admin = await new AccountsService(db).createLocal({
      login: "root",
      password: "correct horse battery",
      displayName: "R",
      enterpriseAdmin: true,
    });
    expect((await s.get()).orgCreation).toBe("anyone");
    expect((await s.update({ orgCreation: "enterprise_admin" }, admin.id)).orgCreation).toBe(
      "enterprise_admin",
    );
    expect((await s.get()).orgCreation).toBe("enterprise_admin");
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
    const s = new SettingsService(db, log);
    expect(await s.get()).toEqual({ orgCreation: "anyone" });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({ key: "orgCreation" });
  });

  it("逐键校验：合法的键保留（另一个键非法不会丢掉它）", async () => {
    await db.deleteFrom("deployment_settings").execute();
    await db
      .insertInto("deployment_settings")
      .values({ key: "orgCreation", value: JSON.stringify("enterprise_admin") })
      .execute();
    const warns: string[] = [];
    const s = new SettingsService(db, { warn: (msg) => warns.push(msg) });
    expect((await s.get()).orgCreation).toBe("enterprise_admin");
    expect(warns).toEqual([]);
  });
});
