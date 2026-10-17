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
});
