import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { DEPLOYMENT_SETTINGS_PATCH } from "../../src/identity/settings.js";
import { OrgSettingsPatchSchema, OrgSettingsSchema } from "../../src/orgs/settings.service.js";
import {
  COMPACTION_SETTINGS,
  CompactionSettingsService,
  effectiveCompactionSettings,
} from "../../src/runtime/compaction-settings.service.js";
import {
  accountsFor,
  apiTokensFor,
  handlesFor,
  orgSettingsFor,
  orgsFor,
  settingsFor,
} from "../helpers/identity.js";

const defaults = COMPACTION_SETTINGS.parse({});

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
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});

/** The service over the test's own pool (the same handles the settings service uses). */
const service = () => new CompactionSettingsService(settingsFor(raw), handlesFor(raw).db);

/** A live org with no settings of its own. */
async function createOrg(id: string): Promise<void> {
  await db.insertInto("orgs").values({ id, slug: id, name: id }).execute();
}

beforeEach(async () => {
  await db.deleteFrom("deployment_settings").execute();
  await db.deleteFrom("orgs").execute();
});

describe("COMPACTION_SETTINGS", () => {
  it("fills every field with its default", () => {
    expect(defaults).toEqual({
      enabled: true,
      threshold: 0.8,
      keepRecentTurns: 4,
      reserveTokens: 8000,
      maxOutputTokens: 20_000,
    });
  });

  it("rejects values outside the ranges", () => {
    expect(() => COMPACTION_SETTINGS.parse({ threshold: 0.99 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ threshold: 0.49 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ keepRecentTurns: 21 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ keepRecentTurns: -1 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ keepRecentTurns: 2.5 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ reserveTokens: 50_001 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ reserveTokens: -1 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ maxOutputTokens: 1023 })).toThrow();
    expect(() => COMPACTION_SETTINGS.parse({ maxOutputTokens: 32_001 })).toThrow();
  });

  it("accepts the range bounds", () => {
    expect(COMPACTION_SETTINGS.parse({ threshold: 0.5 }).threshold).toBe(0.5);
    expect(COMPACTION_SETTINGS.parse({ threshold: 0.95 }).threshold).toBe(0.95);
    expect(COMPACTION_SETTINGS.parse({ keepRecentTurns: 0 }).keepRecentTurns).toBe(0);
    expect(COMPACTION_SETTINGS.parse({ keepRecentTurns: 20 }).keepRecentTurns).toBe(20);
    expect(COMPACTION_SETTINGS.parse({ reserveTokens: 0 }).reserveTokens).toBe(0);
    expect(COMPACTION_SETTINGS.parse({ maxOutputTokens: 1024 }).maxOutputTokens).toBe(1024);
    expect(COMPACTION_SETTINGS.parse({ maxOutputTokens: 32_000 }).maxOutputTokens).toBe(32_000);
  });
});

describe("effectiveCompactionSettings", () => {
  it("an org value wins over the platform's", () => {
    expect(
      effectiveCompactionSettings({ ...defaults, threshold: 0.8 }, { threshold: 0.6 }).threshold,
    ).toBe(0.6);
  });

  it("no org override follows the platform", () => {
    expect(effectiveCompactionSettings({ ...defaults, threshold: 0.8 }, undefined).threshold).toBe(
      0.8,
    );
  });

  it("merges field by field, leaving the others to the platform", () => {
    const platform = { ...defaults, threshold: 0.7, keepRecentTurns: 6 };
    expect(effectiveCompactionSettings(platform, { keepRecentTurns: 2 })).toEqual({
      ...platform,
      keepRecentTurns: 2,
    });
  });
});

describe("CompactionSettingsService.resolve", () => {
  it("with no stored settings: the built-in defaults", async () => {
    await createOrg("org-default");
    expect(await service().resolve("org-default")).toEqual(defaults);
  });

  it("platform: a partial stored value merges into the defaults", async () => {
    await db
      .insertInto("deployment_settings")
      .values({ key: "compaction", value: JSON.stringify({ threshold: 0.6 }) })
      .execute();
    await createOrg("org-platform");
    expect(await service().resolve("org-platform")).toEqual({ ...defaults, threshold: 0.6 });
  });

  it("org: values override the platform, absent fields follow it", async () => {
    await db
      .insertInto("deployment_settings")
      .values({ key: "compaction", value: JSON.stringify({ threshold: 0.6 }) })
      .execute();
    await createOrg("org-override");
    await db
      .updateTable("orgs")
      .set({
        settings: JSON.stringify({
          compaction: { enabled: false, keepRecentTurns: 2, reserveTokens: 1000 },
        }),
      })
      .where("id", "=", "org-override")
      .execute();
    expect(await service().resolve("org-override")).toEqual({
      ...defaults,
      threshold: 0.6,
      enabled: false,
      keepRecentTurns: 2,
      reserveTokens: 1000,
    });
  });

  it("an invalid stored org override is ignored (the platform applies)", async () => {
    await db
      .insertInto("deployment_settings")
      .values({ key: "compaction", value: JSON.stringify({ threshold: 0.7 }) })
      .execute();
    await createOrg("org-invalid");
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ compaction: { threshold: 0.99 } }) })
      .where("id", "=", "org-invalid")
      .execute();
    expect(await service().resolve("org-invalid")).toEqual({ ...defaults, threshold: 0.7 });
  });

  it("an invalid stored platform value falls back to the defaults", async () => {
    await db
      .insertInto("deployment_settings")
      .values({ key: "compaction", value: JSON.stringify({ threshold: 2 }) })
      .execute();
    await createOrg("org-bad-platform");
    expect(await service().resolve("org-bad-platform")).toEqual(defaults);
  });
});

describe("partial compaction forms", () => {
  it("an org override keeps only the fields the org gives (no defaults injected)", () => {
    expect(OrgSettingsSchema.parse({ compaction: { keepRecentTurns: 2 } }).compaction).toEqual({
      keepRecentTurns: 2,
    });
    // an invalid stored value reads as absent (follow the platform)
    expect(OrgSettingsSchema.parse({ compaction: { threshold: 0.99 } }).compaction).toBeUndefined();
  });

  it("the org patch validates the same ranges and takes null to clear", () => {
    expect(OrgSettingsPatchSchema.parse({ compaction: { threshold: 0.6 } }).compaction).toEqual({
      threshold: 0.6,
    });
    expect(OrgSettingsPatchSchema.parse({ compaction: null }).compaction).toBeNull();
    expect(() => OrgSettingsPatchSchema.parse({ compaction: { keepRecentTurns: 21 } })).toThrow();
  });

  it("the platform patch keeps only the fields it gives (no defaults injected)", () => {
    expect(DEPLOYMENT_SETTINGS_PATCH.parse({ compaction: { threshold: 0.6 } }).compaction).toEqual({
      threshold: 0.6,
    });
  });
});

describe("OrgSettingsService.update compaction", () => {
  it("merges a partial into the stored fields; null clears the override; a person may change it", async () => {
    const owner = await accountsFor(raw).createLocal({
      login: "compaction-owner",
      password: "correct horse battery",
      displayName: "O",
    });
    const org = await orgsFor(raw, settingsFor(raw), apiTokensFor(raw)).create(
      { name: "Compaction" },
      owner,
    );
    const svc = orgSettingsFor(raw, () => ({}));
    expect(
      (await svc.update(org.id, { compaction: { threshold: 0.6 } }, owner.id)).compaction,
    ).toEqual({ threshold: 0.6 });
    expect(
      (await svc.update(org.id, { compaction: { keepRecentTurns: 2 } }, owner.id)).compaction,
    ).toEqual({ threshold: 0.6, keepRecentTurns: 2 });
    expect((await svc.update(org.id, { compaction: null }, owner.id)).compaction).toBeUndefined();
    // an empty object is the same as none: it does not store an empty override
    expect((await svc.update(org.id, { compaction: {} }, owner.id)).compaction).toBeUndefined();
  });
});
