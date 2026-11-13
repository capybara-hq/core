import { randomUUID } from "node:crypto";
import type { DeviceHello, DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import {
  type DevicePathsPayload,
  devicePathsChange,
  devicePathsText,
} from "../../src/runtime/context/device-paths.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
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
 * The mode and network the model is told (`DevicesService.modeLevel`, auto mode spec §4.2): a
 * local device's reported mode cut to the org's switch, its sandbox-mode allowlist, a policy the
 * machine pushes afterwards, and a cloud device whose new limits wait for a file reset.
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
}, 180_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await sql`UPDATE capybara.orgs SET settings = settings - 'autoMode' - 'cloudNetwork' WHERE id = ${orgId}`.execute(
    raw,
  );
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const HELLO: DeviceHello = {
  type: "hello",
  protocol: 1,
  programVersion: "0.3.0",
  os: "darwin",
  arch: "arm64",
  mode: "os",
  roots: { workspace: "/w", skills: "/s", tmp: "/t" },
  sessionIsolation: false,
  features: ["networkReport", "policyOp", "mode"],
};

const SUMMARY = (p: Partial<DeviceLocalPolicySummary> = {}): DeviceLocalPolicySummary => ({
  mode: "auto",
  allowedDomains: [],
  ...p,
});

/** A local device of the owner whose machine said hello with `policy`. */
async function localDevice(policy: Partial<DeviceLocalPolicySummary> = {}): Promise<string> {
  const { deviceId, machineId } = await k.app.get(TransactionHost).run(async () => {
    const { id } = await devices.createLocal(orgId, ownerId, `Box ${randomUUID().slice(0, 6)}`);
    const issued = await k.app.get(MachinesService).issue({
      orgId,
      deviceId: id,
      accountId: ownerId,
      name: "box",
      os: "darwin",
      arch: "arm64",
      programVersion: "0.3.0",
    });
    return { deviceId: id, machineId: issued.machineId };
  });
  await k.app.get(MachinesService).recordHello(machineId, {
    ...HELLO,
    policy: SUMMARY(policy),
  });
  return deviceId;
}

describe("DevicesService.modeLevel", { timeout: 30_000 }, () => {
  it("a local device carries its reported mode and the org's sandbox-mode allowlist", async () => {
    const deviceId = await localDevice();
    expect(await devices.modeLevel(orgId, deviceId)).toEqual({
      mode: "auto",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: ["*.example.com"] },
      local: true,
    });
  });

  it("the org turning auto mode off cuts a device that reports auto to sandbox", async () => {
    const deviceId = await localDevice();
    await sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({ autoMode: "off" })}::jsonb
      WHERE id = ${orgId}`.execute(raw);
    expect(await devices.modeLevel(orgId, deviceId)).toMatchObject({
      mode: "sandbox",
      allowedMode: "sandbox",
      local: true,
    });
  });

  it("a policy the machine pushes after its hello reaches the level and the next device_paths", async () => {
    const deviceId = await localDevice();
    const machines = k.app.get(MachinesService);
    const machineId = (await machines.activeFor(deviceId))?.id as string;
    const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
    const before = await devices.modeLevel(orgId, deviceId);
    const first = devicePathsChange(undefined, roots, undefined, before ?? undefined);
    expect(devicePathsText(first?.payload as DevicePathsPayload)).toContain(
      "Mode: auto. Commands run as the user on this machine",
    );
    // the owner ran `capybara-device mode sandbox` and allowed a host: the program pushes it
    const summary: DeviceLocalPolicySummary = { mode: "sandbox", allowedDomains: ["a.com"] };
    await machines.recordPolicy(machineId, summary);
    expect((await machines.activeFor(deviceId))?.localPolicy).toEqual(summary);
    const after = await devices.modeLevel(orgId, deviceId);
    expect(after).toMatchObject({
      mode: "sandbox",
      local: true,
      network: { kind: "allowlist", hosts: ["*.example.com"] },
    });
    // the next sandbox call records a new device_paths event, which tells the model
    const next = devicePathsChange(
      { seq: 7, payload: first?.payload as DevicePathsPayload },
      roots,
      undefined,
      after ?? undefined,
    );
    expect(next).not.toBeNull();
    expect(devicePathsText(next?.payload as DevicePathsPayload)).toContain(
      "Mode: sandbox. Only the workspace, skills and temporary files are writable",
    );
    // a change made on the machine is audited as a mode change
    const audits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", deviceId)
      .where("action", "=", "device.mode_changed")
      .execute();
    expect(audits).toEqual([
      { detail: { from: "auto", to: "sandbox", by: ownerId, via: "device", machineId } },
    ]);
    // unchanged facts: none
    expect(
      devicePathsChange(
        { seq: 8, payload: next?.payload as DevicePathsPayload },
        roots,
        undefined,
        after ?? undefined,
      ),
    ).toBeNull();
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
        source: "cloud",
        provider: "sandbox-fake",
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
    // an unrecorded instance keeps the effective limits until the file reset
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: null,
      effective: { mode: "auto", network: { kind: "open-public", hosts: [] } },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.modeLevel(orgId, id)).toMatchObject({
      mode: "auto",
      network: { kind: "open-public" },
    });
  });
});
