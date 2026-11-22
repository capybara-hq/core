import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService, type DeviceView } from "../../src/devices/devices.service.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * A dial-in device's sandbox network (device-provider spec, phase 3): it is set on the web like
 * every other device's, within the org's and the platform's ceilings, audited and published with
 * the device's authority epoch; the machine-disconnect route is gone. The device is made on the
 * `fake-dial-in` fixture provider with a signed-in machine.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let ownerId: string;
let owner: Req;
let orgId: string;
let local: { id: string };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }), {
    bootstrap: { dir: bootstrap.dir },
    bootstrapManifest: bootstrap.manifest,
  });
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await enableExtensions(raw, orgId, "fake-dial-in");
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  local = await k.app.get(TransactionHost).run(async () => {
    const created = await k.app
      .get(DevicesService)
      .createDialIn(orgId, ownerId, "fake-dial-in", "Laptop");
    await k.app.get(DialInMachines).issue({
      orgId,
      deviceId: created.id,
      accountId: ownerId,
      name: "laptop",
      os: "darwin",
      arch: "arm64",
      programVersion: "0.1.0",
    });
    return created;
  });
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const base = () => `/api/v1/orgs/${orgId}/devices`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
const patch = (id: string, payload: Record<string, unknown>) =>
  owner({ method: "PATCH", url: `${base()}/${id}`, payload });
const setOrgDeviceNetwork = async (deviceNetwork: unknown) => {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { deviceNetwork },
  });
  expect(res.statusCode, res.body).toBe(200);
};
/** The device's permission authority epoch (its revision; 0 before any publication). */
const authorityEpoch = async (deviceId: string) =>
  (
    await db
      .selectFrom("permission_authority_epochs")
      .select("revision")
      .where("kind", "=", "device")
      .where("id", "=", deviceId)
      .executeTakeFirst()
  )?.revision ?? 0;
const auditOf = (action: string, target: string) =>
  db
    .selectFrom("audit_events")
    .select(["detail"])
    .where("action", "=", action)
    .where("target", "=", target)
    .execute();

describe("a dial-in device's sandbox network", () => {
  it("is a dial-in device with a signed-in machine", async () => {
    const res = await owner({ method: "GET", url: `${base()}/${local.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const device = (res.json() as { device: DeviceView }).device;
    expect(device).toMatchObject({ provider: "fake-dial-in", dialIn: true });
    expect(device.machine).toMatchObject({ name: "laptop" });
  });

  it("local device: open network on the web → clamped by the org ceiling, audited, epoch bumped", async () => {
    await setOrgDeviceNetwork({ ceiling: "allowlist" });
    try {
      const before = await authorityEpoch(local.id);
      const res = await patch(local.id, { network: { mode: "open" } });
      expect(res.statusCode, res.body).toBe(400);
      expect(errCode(res)).toBe("device.network_not_allowed");
      expect(await auditOf("device.network_changed", local.id)).toHaveLength(0);
      await setOrgDeviceNetwork({ ceiling: "open" });
      const ok = await patch(local.id, { network: { mode: "open" } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((ok.json() as { device: DeviceView }).device.sandbox).toMatchObject({
        network: "open",
        ownNetwork: "open",
      });
      expect(await auditOf("device.network_changed", local.id)).toEqual([
        {
          detail: {
            from: { mode: null, hosts: [] },
            to: { mode: "open", hosts: [] },
            by: ownerId,
            via: "web",
          },
        },
      ]);
      expect(await authorityEpoch(local.id)).toBeGreaterThan(before);
    } finally {
      await setOrgDeviceNetwork(null);
    }
  });

  it("DELETE /devices/:id/machine is gone", async () => {
    const res = await owner({ method: "DELETE", url: `${base()}/${local.id}/machine` });
    expect(res.statusCode).toBe(404);
    // the machine stays signed in
    const view = await owner({ method: "GET", url: `${base()}/${local.id}` });
    expect((view.json() as { device: DeviceView }).device.machine).not.toBeNull();
  });

  it("devices.set-network narrows a local device too", async () => {
    const o = k.app.get(PlatformOperations).get("devices.set-network");
    if (o === null) throw new Error("no devices.set-network");
    const ctx = {
      orgId,
      actorAccountId: ownerId,
      agentId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      signal: new AbortController().signal,
    };
    const input = o.input.parse({
      deviceId: local.id,
      network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
    });
    expect(await o.precheck?.(input, ctx)).toEqual({ ok: true });
    const r = (await o.run(input, ctx)) as {
      device: { dialIn: boolean; sandbox: { network: string; hosts: string[] } };
    };
    expect(r.device).toMatchObject({
      dialIn: true,
      sandbox: { network: "allowlist", hosts: ["registry.npmjs.org"] },
    });
    expect((await auditOf("device.network_changed", local.id)).at(-1)?.detail).toMatchObject({
      to: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
      via: "agent",
      operation: "devices.set-network",
    });
  });
});
