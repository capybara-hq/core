import { randomUUID } from "node:crypto";
import type { DeviceProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { SUPPORTS_BOTH } from "../helpers/installed-evidence.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The mode and network the model is told (`DevicesService.modeLevel`, auto mode spec §4.2): an
 * operation-boundary device's mode cut to the org's switch, the device's own network choice, and a
 * cloud device whose new limits wait for a file reset.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let devices: DevicesService;
let owner: Req;
let ownerId: string;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        sandbox: { limits: { egress: "allowlist", allowHosts: ["*.example.com"] } },
      },
    ),
  );
  devices = k.app.get(DevicesService);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sql`UPDATE capybara.orgs SET settings = settings - 'outsideSandbox' - 'deviceNetwork' WHERE id = ${orgId}`.execute(
    raw,
  );
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** An in-process provider whose devices run each operation on their machine. */
const MACHINE_PROVIDER = "@mode-test";

/**
 * A device of the owner whose provider runs each operation on its machine (an operation boundary
 * allowing work outside the sandbox), as its stored report and support say.
 */
async function localDevice(): Promise<string> {
  k.app
    .get(DeviceProviders)
    .register({ plugin: MACHINE_PROVIDER, version: "0.0.0", impl: {} as DeviceProvider });
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: ownerId,
      name: `Box ${deviceId.slice(0, 6)}`,
      provider: MACHINE_PROVIDER,
    })
    .execute();
  await sql`UPDATE capybara.devices SET report = ${JSON.stringify({
    revision: "r1",
    description: { en: "Runs commands on this machine" },
    home: null,
    limits: [],
    reset: false,
    support: SUPPORTS_BOTH,
  })}::jsonb WHERE id = ${deviceId}`.execute(raw);
  return deviceId;
}

describe("DevicesService.modeLevel", () => {
  it("a device whose provider runs operations on its machine carries its tier, network and local", async () => {
    const deviceId = await localDevice();
    // the owner's network is open (a new install's default): the sandbox network is open
    expect(await devices.modeLevel(orgId, deviceId)).toEqual({
      mode: "auto",
      allowedMode: "auto",
      network: { kind: "open-public", hosts: [] },
      local: true,
    });
  });

  it("the device's own network choice reaches the level, the same setting for every provider", async () => {
    const deviceId = await localDevice();
    await sql`UPDATE capybara.devices SET network_mode = 'allowlist',
      network_hosts = ${JSON.stringify(["api.example.com"])}::jsonb WHERE id = ${deviceId}`.execute(
      raw,
    );
    // the device's list narrows the org's hosts (`*.example.com`)
    expect((await devices.modeLevel(orgId, deviceId))?.network).toEqual({
      kind: "allowlist",
      hosts: ["api.example.com"],
    });
  });

  it("a device whose own network is closed reaches the level as an allowlist with no host", async () => {
    const deviceId = await localDevice();
    await sql`UPDATE capybara.devices SET network_mode = 'none', network_hosts = '[]'::jsonb
      WHERE id = ${deviceId}`.execute(raw);
    expect((await devices.modeLevel(orgId, deviceId))?.network).toEqual({
      kind: "allowlist",
      hosts: [],
    });
  });

  it("a provider allowing work outside the sandbox is cut where auto mode is not allowed (one derivation)", async () => {
    const deviceId = await localDevice();
    await sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({ outsideSandbox: "off" })}::jsonb
      WHERE id = ${orgId}`.execute(raw);
    expect(await k.app.get(SandboxService).devicePolicy({ orgId, deviceId })).toMatchObject({
      mode: "sandbox",
      allowedMode: "sandbox",
    });
    expect((await devices.modeLevel(orgId, deviceId))?.mode).toBe("sandbox");
  });

  it("the org turning auto mode off cuts a device that reports auto to sandbox", async () => {
    const deviceId = await localDevice();
    await sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({ outsideSandbox: "off" })}::jsonb
      WHERE id = ${orgId}`.execute(raw);
    expect(await devices.modeLevel(orgId, deviceId)).toMatchObject({
      mode: "sandbox",
      allowedMode: "sandbox",
      local: true,
    });
  });

  it("a cloud device waiting for a file reset reports the mode and network its instance still has", async () => {
    const id = randomUUID();
    await db
      .insertInto("devices")
      .values({
        id,
        org_id: orgId,
        owner_kind: "personal",
        owner_account_id: ownerId,
        name: `Cloud ${id.slice(0, 6)}`,
        provider: "device-fake",
      })
      .execute();
    expect(await devices.modeLevel(orgId, id)).toMatchObject({
      mode: "auto",
      local: false,
      network: { kind: "open-public" },
    });
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.com"] } },
      effective: { mode: "auto", network: { kind: "open-public", hosts: [] } },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.modeLevel(orgId, id)).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: ["a.com"] },
    });
    // an unrecorded instance may be wider than the effective limits: the widest is reported
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: null,
      effective: { mode: "sandbox", network: { kind: "allowlist", hosts: ["a.com"] } },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.modeLevel(orgId, id)).toMatchObject({
      mode: "auto",
      network: { kind: "open-public", hosts: [] },
    });
  });
});
