import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceAccess } from "../../src/devices/access.js";
import { ConversationDevices, NO_DEVICE } from "../../src/devices/conversation-devices.js";
import { DEVICES_DEFAULT_PROVIDER_SETTING } from "../../src/devices/default-provider-setting.js";
import { DeviceProviderSelection } from "../../src/devices/device-provider-selection.js";
import { ApiError } from "../../src/errors.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  ENV_UNAVAILABLE_TEXT,
  mapSandboxError,
  NO_DEVICE_TEXT,
  unavailableWhenNoSandbox,
} from "../../src/tools/builtins/sandbox/common.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  enableExtensions,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { seedDevice } from "../helpers/sandbox.js";

/** An in-process provider: a test stub registered beside the extensions. */
const IN_PROCESS = "@in-process";

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
  // no provider on yet: each test switches on what it needs
  orgA = await createOrg(req, "Alpha");
  orgB = await createOrg(req, "Beta");
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
  it("onInOrg lists the providers enabled in the org, in name order, never an in-process one", async () => {
    providers.register({ plugin: IN_PROCESS, version: "in-process-test", impl: {} as never });
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

  it("forDevice finds an in-process provider as registered and an extension by plugin name; unknown → undefined", () => {
    providers.register({ plugin: IN_PROCESS, version: "in-process-test", impl: {} as never });
    expect(providers.forDevice(IN_PROCESS)?.plugin).toBe(IN_PROCESS);
    const b = providers.forDevice("device-fake-b");
    expect(b?.plugin).toBe("device-fake-b");
    expect(b?.version).toBe("0.1.0");
    expect(providers.forDevice(IN_PROCESS)?.version).toBe("in-process-test");
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

describe("a device's use follows its own provider's org switch", () => {
  /** A cloud device of the org creator in `orgId`, bound to `provider`. */
  const deviceOn = async (orgId: string, provider: string) => {
    const id = await seedDevice(raw, orgId, ownerId);
    await sql`UPDATE capybara.devices SET provider = ${provider} WHERE id = ${id}`.execute(raw);
    return id;
  };
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => (e as { code?: string }).code,
    );

  it("provider switched on in one org only: org B's device unavailable, org A's works; a toggle flips it at once", async () => {
    const access = k.app.get(DeviceAccess);
    const sandbox = k.app.get(SandboxService);
    await enableExtensions(raw, orgA, "device-fake-b");
    const a = await deviceOn(orgA, "device-fake-b");
    const b = await deviceOn(orgB, "device-fake-b");
    expect(await access.usable(orgA, ownerId, a)).toEqual({ id: a, provider: "device-fake-b" });
    expect(await codeOf(access.usable(orgB, ownerId, b))).toBe("device.unavailable");
    expect(await sandbox.availableFor(a, orgA)).toBe(true);
    expect(await sandbox.availableFor(b, orgB)).toBe(false);
    // the other org's answer never leaks: a device is judged in its own org only
    expect(await sandbox.availableFor(b, orgA)).toBe(false);
    await enableExtensions(raw, orgB, "device-fake-b");
    expect(await access.usable(orgB, ownerId, b)).toEqual({ id: b, provider: "device-fake-b" });
    await setEnabled(orgA, "device-fake-b", false);
    expect(await codeOf(access.usable(orgA, ownerId, a))).toBe("device.unavailable");
    expect(await sandbox.availableFor(a, orgA)).toBe(false);
  });

  it("a device of one provider is never served by another provider that is on", async () => {
    await enableExtensions(raw, orgA, "device-fake");
    const b = await deviceOn(orgA, "device-fake-b");
    expect(await codeOf(k.app.get(DeviceAccess).usable(orgA, ownerId, b))).toBe(
      "device.unavailable",
    );
    expect(await k.app.get(SandboxService).availableFor(b, orgA)).toBe(false);
  });

  it("the tool listing says the bound device's provider is off, not that no provider is on", async () => {
    // two providers on in the org; the conversation's device is on device-fake-b, switched off
    await enableExtensions(raw, orgA, "device-fake", "device-fake-b");
    const dev = await deviceOn(orgA, "device-fake-b");
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgA}, ${ownerId}, 'org', 1)`.execute(raw);
    const conv = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${conv}, ${orgA}, ${agentId}, ${ownerId}, ${dev})`.execute(raw);
    const devices = k.app.get(ConversationDevices);
    const listing = unavailableWhenNoSandbox({ devices } as never);
    expect(await devices.unusableReason(orgA, conv)).toBeNull();
    expect(await listing({ orgId: orgA, conversationId: conv })).toBeNull();
    await setEnabled(orgA, "device-fake-b", false);
    expect(await devices.unusableReason(orgA, conv)).toBe("provider-off");
    expect(await listing({ orgId: orgA, conversationId: conv })).toBe(
      ENV_UNAVAILABLE_TEXT.slice(0, -1),
    );
    // without a conversation, a provider is still on in the org
    expect(await devices.unusableReason(orgA)).toBeNull();
    // nothing on at all: no provider is on in the org
    await setEnabled(orgA, "device-fake", false);
    expect(await devices.unusableReason(orgA)).toBe("none");
    expect(await listing({ orgId: orgA })).toMatch(
      /^No device provider is on in this organization/,
    );
  });

  it("providers on but no default device and no default provider: no device, not no provider", async () => {
    await enableExtensions(raw, orgA, "device-fake", "device-fake-b");
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgA}, ${ownerId}, 'org', 1)`.execute(raw);
    const conv = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${conv}, ${orgA}, ${agentId}, ${ownerId}, NULL)`.execute(raw);
    const devices = k.app.get(ConversationDevices);
    const listing = unavailableWhenNoSandbox({ devices } as never);
    expect(await devices.unusableReason(orgA, conv)).toBe("no-device");
    expect(await listing({ orgId: orgA, conversationId: conv })).toBe(NO_DEVICE_TEXT.slice(0, -1));
    // a tool call finds nothing to bind: the same reason, mapped to the same text
    const err = await devices.forTool(orgA, conv).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.unavailable");
    expect((err as ApiError).details).toEqual([{ reason: NO_DEVICE }]);
    expect((mapSandboxError(err, undefined) as Error).message).toBe(NO_DEVICE_TEXT);
    // with a default provider the default device can be made: usable
    await setOrgDefault(orgA, "device-fake");
    expect(await devices.unusableReason(orgA, conv)).toBeNull();
    // every provider off: no provider is on, said as such
    await setOrgDefault(orgA, null);
    await setEnabled(orgA, "device-fake", false);
    await setEnabled(orgA, "device-fake-b", false);
    expect(await devices.unusableReason(orgA, conv)).toBe("none");
    expect(await devices.forTool(orgA, conv).catch((e: ApiError) => e.details)).toBeUndefined();
  });

  it("isOnInOrg: an in-process provider is on in every org while registered (no catalog item, no org switch)", async () => {
    providers.register({ plugin: IN_PROCESS, version: "in-process-test", impl: {} as never });
    expect(await names(orgA)).toEqual([]);
    expect(await selection.isOnInOrg(orgA, IN_PROCESS)).toBe(true);
    expect(await selection.isOnInOrg(orgB, IN_PROCESS)).toBe(true);
    expect(await selection.isOnInOrg(orgA, "@not-registered")).toBe(false);
    // and still never listed among the org's providers
    expect(await names(orgA)).toEqual([]);
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
