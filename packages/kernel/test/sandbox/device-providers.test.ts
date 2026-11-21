import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DEVICES_DEFAULT_PROVIDER_SETTING } from "../../src/devices/default-provider-setting.js";
import { DeviceProviderSelection } from "../../src/devices/device-provider-selection.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { DeviceProviders, LOCAL_PROVIDER } from "../../src/sandbox/providers.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrgWithProviders,
  enableExtensions,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * `DeviceProviders` (device-provider spec): which providers serve an org (loaded and switched on in
 * it), a device's provider by name, and the org's default device provider. Two real fixture
 * extensions are loaded; the org switch lives in PG and is read at every call.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let providers: DeviceProviders;
let selection: DeviceProviderSelection;
let settings: OrgSettingsService;
let ownerId: string;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "device-providers-"));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fixture("device-fake"), fixture("device-fake-b")],
        extensionPermissions: { autoApprove: true },
        extensionConfig: {
          "device-fake": { root: join(root, "a") },
          "device-fake-b": { root: join(root, "b") },
        },
      },
    ),
  );
  providers = k.app.get(DeviceProviders);
  selection = k.app.get(DeviceProviderSelection);
  settings = k.app.get(OrgSettingsService);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const req = await session(k, "owner");
  orgA = await createOrgWithProviders(k, req, "Alpha");
  orgB = await createOrgWithProviders(k, req, "Beta");
});

const setEnabled = (orgId: string, plugin: string, enabled: boolean) =>
  sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
    VALUES (${plugin}, ${orgId}, ${enabled})
    ON CONFLICT (plugin, org_id) DO UPDATE SET enabled = ${enabled}`.execute(raw);
const names = async (orgId: string) => (await selection.onInOrg(orgId)).map((e) => e.plugin);
const setPlatformDefault = (provider: string) =>
  sql`INSERT INTO capybara.deployment_settings (key, value)
    VALUES (${DEVICES_DEFAULT_PROVIDER_SETTING}, ${JSON.stringify({ provider })}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(raw);
const setOrgDefault = (orgId: string, provider: string | null) =>
  settings.update(orgId, { deviceDefaultProvider: provider }, ownerId);

describe("DeviceProviders and DeviceProviderSelection", () => {
  it("onInOrg lists the providers enabled in the org, in name order, never @local", async () => {
    providers.register({ plugin: LOCAL_PROVIDER, version: "local-test", impl: {} as never });
    expect(await names(orgA)).toEqual([]);
    await enableExtensions(raw, orgA, "device-fake-b", "device-fake");
    expect(await names(orgA)).toEqual(["device-fake", "device-fake-b"]);
  });

  it("provider switched on in one org only: onInOrg differs per org and follows a toggle at once", async () => {
    await enableExtensions(raw, orgA, "device-fake");
    await enableExtensions(raw, orgB, "device-fake-b");
    expect(await names(orgA)).toEqual(["device-fake"]);
    expect(await names(orgB)).toEqual(["device-fake-b"]);
    await setEnabled(orgA, "device-fake", false);
    expect(await names(orgA)).toEqual([]);
    expect(await selection.isOnInOrg(orgB, "device-fake-b")).toBe(true);
    expect(await selection.isOnInOrg(orgA, "device-fake")).toBe(false);
    await setEnabled(orgA, "device-fake", true);
    expect(await names(orgA)).toEqual(["device-fake"]);
  });

  it("forDevice finds @local in the internal map and an extension by plugin name; unknown → undefined", () => {
    providers.register({ plugin: LOCAL_PROVIDER, version: "local-test", impl: {} as never });
    expect(providers.forDevice(LOCAL_PROVIDER)?.plugin).toBe(LOCAL_PROVIDER);
    const b = providers.forDevice("device-fake-b");
    expect(b?.plugin).toBe("device-fake-b");
    expect(b?.version).toBe("0.1.0");
    expect(providers.forDevice(LOCAL_PROVIDER)?.version).toBe("local-test");
    expect(providers.forDevice("nope")).toBeUndefined();
    expect(providers.forDevice("@nope")).toBeUndefined();
    expect(
      providers
        .loaded()
        .map((e) => e.plugin)
        .sort(),
    ).toEqual(["device-fake", "device-fake-b"]);
  });

  it("defaultFor: org override wins; platform otherwise; a default not on in the org → undefined", async () => {
    await enableExtensions(raw, orgA, "device-fake", "device-fake-b");
    expect(await selection.defaultFor(orgA)).toBeUndefined();
    await setPlatformDefault("device-fake");
    expect((await selection.defaultFor(orgA))?.plugin).toBe("device-fake");
    await setOrgDefault(orgA, "device-fake-b");
    expect((await selection.defaultFor(orgA))?.plugin).toBe("device-fake-b");
    // another org still follows the platform (it has the platform's provider on, so it resolves)
    await enableExtensions(raw, orgB, "device-fake");
    expect((await selection.defaultFor(orgB))?.plugin).toBe("device-fake");
    // switched off in the org: none, not the platform's provider
    await setEnabled(orgA, "device-fake-b", false);
    expect(await selection.defaultFor(orgA)).toBeUndefined();
    // clearing the override follows the platform again
    await setOrgDefault(orgA, null);
    expect((await selection.defaultFor(orgA))?.plugin).toBe("device-fake");
  });

  it("defaultFor: a platform default that is unknown or not on in the org is none", async () => {
    await enableExtensions(raw, orgA, "device-fake-b");
    await setPlatformDefault("device-fake");
    expect(await selection.defaultFor(orgA)).toBeUndefined();
    await setPlatformDefault("not-installed");
    expect(await selection.defaultFor(orgA)).toBeUndefined();
  });
});

describe("org deviceDefaultProvider through the real kernel app", () => {
  it("is refused for a provider that is not on in the org, accepted once it is", async () => {
    await expect(setOrgDefault(orgA, "device-fake-b")).rejects.toMatchObject({
      code: "org.device_provider_not_available",
    });
    await enableExtensions(raw, orgA, "device-fake-b");
    expect(await setOrgDefault(orgA, "device-fake-b")).toMatchObject({
      deviceDefaultProvider: "device-fake-b",
    });
  });
});
