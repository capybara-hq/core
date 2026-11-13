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
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { TIER_GRANT_SPEC_HASH, TIER_OPEN_GRANT_KEY } from "../../src/schedules/unattended.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The sandbox level the model is told (`DevicesService.sandboxLevel`, sandbox dev tiers spec
 * §11.5): the network switch, a cloud device whose new limits wait for a file reset, a local
 * device's machine facts and the scheduled-run cap.
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
        sandbox: {
          limits: { egress: "allowlist", allowHosts: ["*.example.com"] },
          tiers: { max: "open", default: "dev" },
        },
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
  await sql`UPDATE capybara.orgs SET settings = settings - 'sandboxEgress' WHERE id = ${orgId}`.execute(
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
  features: ["networkReport", "policyOp", "tiers"],
};

/** A local device of the owner whose machine said hello with `policy`. */
async function localDevice(policy: Partial<DeviceLocalPolicySummary>): Promise<string> {
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
    policy: {
      tier: "open",
      effectiveTier: "open",
      isolation: "sandbox",
      localhost: "off-proxy-detected",
      unixSockets: "roots",
      allowedDomains: [],
      remoteGrants: "owner",
      ...policy,
    },
  });
  return deviceId;
}

/** A kernel run serving a scheduled task run on `deviceId` (with the task's `grants`). */
async function scheduledRun(deviceId: string, grants: string[]): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const agentId = (res.json() as { agent: { id: string } }).agent.id;
  const conversationId = await createConv(owner, orgId, agentId);
  const taskId = randomUUID();
  await db
    .insertInto("scheduled_tasks")
    .values({
      id: taskId,
      org_id: orgId,
      account_id: ownerId,
      agent_id: agentId,
      name: "Nightly",
      prompt: "Build.",
      trigger: JSON.stringify({ kind: "cron", expr: "0 9 * * *" }),
      mode: "new",
      device_id: deviceId,
    })
    .execute();
  for (const key of grants) {
    await db
      .insertInto("scheduled_task_grants")
      .values({
        task_id: taskId,
        tool_key: key,
        spec_hash: TIER_GRANT_SPEC_HASH,
        connector_id: null,
      })
      .execute();
  }
  const taskRunId = randomUUID();
  await new ScheduledTaskStore().insertRun(db, {
    id: taskRunId,
    taskId,
    orgId,
    scheduledFor: new Date(),
    trial: false,
    status: "running",
  });
  const runId = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, scheduled_task_run_id)
    VALUES (${runId}, ${conversationId}, 'running', 1, ${ownerId}, 0, ${taskRunId})`.execute(raw);
  return runId;
}

describe("DevicesService.sandboxLevel", () => {
  it("a local device carries its machine's facts; a scheduled run without tier:open is capped at dev", async () => {
    const deviceId = await localDevice({});
    expect(await devices.sandboxLevel(orgId, deviceId)).toEqual({
      tier: "open",
      isolation: "sandbox",
      localhost: "off-proxy-detected",
      unixSockets: "roots",
    });
    const run = await scheduledRun(deviceId, []);
    expect(await devices.sandboxLevel(orgId, deviceId, run)).toEqual({
      tier: "dev",
      isolation: "sandbox",
      localhost: "off-proxy-detected",
      unixSockets: "roots",
      unattended: true,
    });
    const granted = await scheduledRun(deviceId, [TIER_OPEN_GRANT_KEY]);
    expect(await devices.sandboxLevel(orgId, deviceId, granted)).toMatchObject({
      tier: "open",
      unattended: true,
    });
    // an attended run (no task run) is not capped
    expect(await devices.sandboxLevel(orgId, deviceId, randomUUID())).toMatchObject({
      tier: "open",
    });
  });

  it("a policy the machine pushes after its hello reaches the level and the next device_paths", async () => {
    const deviceId = await localDevice({});
    const machines = k.app.get(MachinesService);
    const machineId = (await machines.activeFor(deviceId))?.id as string;
    const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
    const before = await devices.sandboxLevel(orgId, deviceId);
    const first = devicePathsChange(undefined, roots, undefined, before ?? undefined);
    expect(devicePathsText(first?.payload as DevicePathsPayload)).toContain(
      "Local servers are blocked on this machine because a local proxy was detected",
    );
    // the owner ran `capybara-device policy set localhost allow`: the program pushes its summary
    const summary: DeviceLocalPolicySummary = {
      tier: "open",
      effectiveTier: "open",
      isolation: "sandbox",
      localhost: "on",
      unixSockets: "roots",
      allowedDomains: [],
      remoteGrants: "owner",
    };
    await machines.recordPolicy(machineId, summary);
    expect((await machines.activeFor(deviceId))?.localPolicy).toEqual(summary);
    const after = await devices.sandboxLevel(orgId, deviceId);
    expect(after).toMatchObject({ localhost: "on" });
    // the next sandbox call records a new device_paths event, which tells the model
    const next = devicePathsChange(
      { seq: 7, payload: first?.payload as DevicePathsPayload },
      roots,
      undefined,
      after ?? undefined,
    );
    expect(next).not.toBeNull();
    expect(devicePathsText(next?.payload as DevicePathsPayload)).toContain("Local servers work;");
    // unchanged facts: none
    expect(
      devicePathsChange(
        { seq: 8, payload: next?.payload as DevicePathsPayload },
        roots,
        undefined,
        after ?? undefined,
      ),
    ).toBeNull();

    // isolation reported as changed is audited as at a hello; an unreadable summary keeps it
    await machines.recordPolicy(machineId, undefined, { ...summary, isolation: "none", x: 1 });
    expect((await machines.activeFor(deviceId))?.localPolicy).toBeNull();
    const audits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("target", "=", deviceId)
      .where("action", "=", "device.isolation_reported")
      .execute();
    expect(audits).toEqual([{ detail: { machineId, isolation: "none", previous: "sandbox" } }]);
  });

  it("an unsandboxed device capped below open keeps the sandbox", async () => {
    const deviceId = await localDevice({ isolation: "none" });
    expect(await devices.sandboxLevel(orgId, deviceId)).toMatchObject({
      tier: "open",
      isolation: "none",
    });
    const run = await scheduledRun(deviceId, []);
    expect(await devices.sandboxLevel(orgId, deviceId, run)).toMatchObject({
      tier: "dev",
      isolation: "sandbox",
    });
  });

  it("the org's network switched off is network none", async () => {
    const deviceId = await localDevice({});
    await sql`UPDATE capybara.orgs SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
      '{sandboxEgress}', '{"mode":"none"}'::jsonb) WHERE id = ${orgId}`.execute(raw);
    expect(await devices.sandboxLevel(orgId, deviceId)).toMatchObject({
      tier: "open",
      network: "none",
    });
  });

  it("a cloud device waiting for a file reset reports the limits its instance still has", async () => {
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
        tier: "strict",
      })
      .execute();
    expect(await devices.sandboxLevel(orgId, id)).toEqual({ tier: "strict", isolation: "sandbox" });
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: { tier: "open", egress: "open" },
      effective: { tier: "strict", egress: "allowlist" },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.sandboxLevel(orgId, id)).toEqual({ tier: "open", isolation: "sandbox" });
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: { tier: "dev", egress: "none" },
      effective: { tier: "strict", egress: "allowlist" },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.sandboxLevel(orgId, id)).toEqual({
      tier: "dev",
      isolation: "sandbox",
      network: "none",
    });
    // an unrecorded instance may be wider: open, as the unattended gate counts it
    vi.spyOn(k.app.get(SandboxService), "limitsState").mockResolvedValue({
      applied: null,
      effective: { tier: "strict", egress: "allowlist" },
      pendingNextUse: false,
      pendingFilesReset: true,
    });
    expect(await devices.sandboxLevel(orgId, id)).toEqual({ tier: "open", isolation: "sandbox" });
  });
});
