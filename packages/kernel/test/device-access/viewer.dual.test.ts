import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDualReplicaHarness,
  FAKE_DIAL_IN_PROTOCOL,
  FakeDialInMachine,
  type Harness,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  DEVICE_STREAM_TICKET_PREFIX,
  type DeviceStreamTicket,
} from "../../src/device-access/device-access.service.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import { enableExtensions, PW, waitFor } from "../helpers/runs.js";

/**
 * The viewer endpoint across gateway replicas (browser use spec §6.2): a local device's service
 * stream opens only on the gateway replica holding the machine's socket, so a viewer that reaches
 * another gateway replica hops there once (`/internal/device-stream/<ticketId>`, authenticated
 * with an HMAC under the kernel's key); frames never pass through Redis or PG. Replica A (index 0)
 * runs only the gateway role and holds the machine; replica B (index 1) runs api, worker and
 * gateway and takes the viewer.
 */

const PLUGIN = "fake-dial-in";
const HELLO = { revision: "r1", outsideSandbox: false };

let h: Harness;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let extensionsDir: string;
let cookie = "";
let ownerId: string;
let orgId: string;
const open: FakeDialInMachine[] = [];

type Json = Record<string, unknown>;

async function callTo(replica: 0 | 1, method: string, path: string, body?: unknown) {
  const res = await h.requestTo(replica, path, {
    method,
    headers: {
      "x-capybara-csrf": "1",
      ...(cookie !== "" && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: (text === "" ? {} : JSON.parse(text)) as Json,
  };
}

beforeAll(async () => {
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  extensionsDir = await mkdtemp(join(tmpdir(), "cap-viewer-dual-"));
  h = await createDualReplicaHarness({
    extensions: [MODEL_FAKE],
    bootstrap: { dir: bootstrap.dir, manifest: bootstrap.manifest },
    roles: [["gateway"], ["api", "worker", "gateway"]],
    config: {
      auth: { cookieSecure: false },
      extensionHost: { dir: extensionsDir },
      http: { publicUrl: "https://cap.example" },
      devices: { maxPersonal: 50 },
    },
  });
  raw = createDb(h.dbUrl, 2);
  redis = new Redis(h.redisUrl);
  ownerId = (
    await accountsFor(kernelDb(raw)).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  const login = await callTo(1, "POST", "/api/v1/auth/login", { login: "owner", password: PW });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const org = await callTo(1, "POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  orgId = (org.json.org as { id: string }).id;
  await enableExtensions(raw, orgId, PLUGIN);
});

afterAll(async () => {
  for (const m of open.splice(0)) await m.close();
  await raw?.destroy();
  redis?.disconnect();
  await h?.stop();
  await bootstrap?.cleanup();
  if (extensionsDir) await rm(extensionsDir, { recursive: true, force: true });
});

/** Signs a fake machine in into a new device of the fixture provider (owned by the owner). */
async function signIn() {
  const keys = await redis.keys("throttler:*");
  if (keys.length > 0) await redis.del(...keys);
  const a = await callTo(1, "POST", "/api/v1/device/authorize", {
    name: "box",
    os: "linux",
    arch: "x64",
    programVersion: "0.0.0-fake",
    protocol: FAKE_DIAL_IN_PROTOCOL,
  });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const c = await callTo(1, "POST", "/api/v1/device/confirm", {
    userCode: a.json.userCode,
    orgId,
    provider: PLUGIN,
    name: `Box ${randomUUID().slice(0, 8)}`,
  });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await callTo(1, "POST", "/api/v1/device/token", { deviceCode: a.json.deviceCode });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return t.json as { credential: string; deviceId: string };
}

const wsBase = (replica: 0 | 1) => `ws://127.0.0.1:${h.replicas[replica].port}`;

/**
 * A device held by a machine on replica A that echoes every stream, a running instance row and
 * a conversation of the owner bound to it; returns a viewer ticket written as the kernel mints
 * one (`DeviceAccessService.mintTicket`, which runs in the replicas' processes).
 */
async function heldDevice() {
  const { credential, deviceId } = await signIn();
  const machine = await FakeDialInMachine.connect({
    url: `${wsBase(0)}/device/connect`,
    credential,
    hello: HELLO,
  });
  open.push(machine);
  const opens: unknown[] = [];
  machine.onStream((o, s) => {
    opens.push(o);
    s.onMessage((m) => void s.send(m));
  });
  await waitFor(() => redis.get(deviceLeaseKey(deviceId)), 10_000, "lease held");
  await sql`INSERT INTO capybara.device_instances
      (device_id, org_id, provider, status, fs_status, handle, fs_handle, had_instance)
    VALUES (${deviceId}, ${orgId}, ${PLUGIN}, 'running', 'ready',
      ${JSON.stringify({ id: deviceId })}::jsonb, ${JSON.stringify({ id: deviceId })}::jsonb, true)
  `.execute(raw);
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${ownerId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${ownerId}, ${deviceId})`.execute(raw);
  const ticket = async (): Promise<string> => {
    const id = randomUUID().replaceAll("-", "");
    const record: DeviceStreamTicket = {
      orgId,
      accountId: ownerId,
      conversationId,
      deviceId,
      providerName: PLUGIN,
      service: "echo",
      extension: PLUGIN,
    };
    await redis.set(`${DEVICE_STREAM_TICKET_PREFIX}${id}`, JSON.stringify(record), "EX", 60);
    return id;
  };
  return { deviceId, machine, opens, ticket };
}

function viewer(url: string) {
  const ws = new WebSocket(url);
  const waiting: ((m: string) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    for (const w of waiting.splice(0)) w(data.toString("utf8"));
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.on("close", (code) => resolve({ code }));
    ws.on("error", () => {});
  });
  const roundTrip = async (text: string): Promise<string> => {
    const answer = new Promise<string>((resolve) => waiting.push(resolve));
    await opened;
    ws.send(Buffer.from(text, "utf8"));
    return answer;
  };
  return { ws, closed, roundTrip };
}

describe("device stream viewer across replicas (dual replica)", () => {
  it("viewer on the non-holding gateway hops to the holder", async () => {
    const d = await heldDevice();
    // B does not hold the machine: it hops to A, which opens the stream over the socket
    const v = viewer(`${wsBase(1)}/device/stream?ticket=${await d.ticket()}`);
    expect(await v.roundTrip("one")).toBe("one");
    expect(await v.roundTrip("two")).toBe("two");
    expect(d.opens).toEqual([{ service: "echo" }]);
    v.ws.close(1000);
    expect((await v.closed).code).toBe(1000);
    // the holder audits the open and the close, once each
    const rows = async (action: string) =>
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM capybara.audit_events
          WHERE action = ${action} AND target = ${d.deviceId}`.execute(raw)
      ).rows[0]?.n;
    await waitFor(async () => (await rows("browser.view_closed")) === 1);
    expect(await rows("browser.view")).toBe(1);

    // on the holder itself the viewer opens locally
    const local = viewer(`${wsBase(0)}/device/stream?ticket=${await d.ticket()}`);
    expect(await local.roundTrip("here")).toBe("here");
    local.ws.close(1000);
    await local.closed;

    // the machine drops: an open viewer closes with 4409 (device-offline)
    const late = viewer(`${wsBase(1)}/device/stream?ticket=${await d.ticket()}`);
    expect(await late.roundTrip("x")).toBe("x");
    await d.machine.close();
    expect((await late.closed).code).toBe(4409);
  });

  it("hop with a bad HMAC is refused", async () => {
    const d = await heldDevice();
    const ticket = await d.ticket();
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${wsBase(0)}/internal/device-stream/${ticket}`, { headers });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on("open", () => {
          resolve(101);
          ws.terminate();
        });
        ws.on("error", () => {});
      });
    expect(await status({})).toBe(401);
    expect(
      await status({ "x-capybara-hop": "ab".repeat(32), "x-capybara-hop-at": String(Date.now()) }),
    ).toBe(401);
    expect(await status({ "x-capybara-hop": "zz", "x-capybara-hop-at": "soon" })).toBe(401);
    expect(d.opens).toEqual([]);
    // the ticket is still there for the real viewer
    expect(await redis.exists(`${DEVICE_STREAM_TICKET_PREFIX}${ticket}`)).toBe(1);
  });
});
