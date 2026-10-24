import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  fakeDm as dm,
  type FakeChannelServer,
  type Harness,
  startFakeChannelServer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { channelLeaseKey } from "../../src/channels/supervisor.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Channel long connections live on the gateway role (E11-A): the supervisor runs only on replicas
 * with `gateway`, while runs and outbound delivery stay on `worker`. Lease and scan intervals are
 * shortened (defaults 30s / 10s) to TTL 3s and a 300ms scan.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const LEASE_TTL_MS = 3000;
const SCAN_MS = 300;

let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await im?.stop();
});

type Json = Record<string, unknown>;

/** Starts a harness with the given roles, then logs in, creates an org, an agent and a channel. */
async function setup(roles: [string[], string[]], appId: string) {
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, CHAN_MINI],
    roles,
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: SCAN_MS },
    },
  });
  const harness = h;
  const raw = createDb(harness.dbUrl, 3);
  cleanups.push(() => raw.destroy());
  const db: KernelDb = kernelDb(raw);

  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await harness.request(path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (path === "/api/v1/auth/login") {
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
  };

  const ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  expect((await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status).toBe(
    200,
  );
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  expect(org.status).toBe(201);
  const base = `/api/v1/orgs/${(org.json.org as { id: string }).id}`;
  const ag = await call("POST", `${base}/agents`, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      tools: [],
    },
    visibility: "org",
  });
  expect(ag.status, JSON.stringify(ag.json)).toBe(201);
  const agentId = (ag.json.agent as { id: string }).id;
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  expect((await call("PUT", `${base}/extensions/chan-mini`, { enabled: true })).status).toBe(200);
  const ch = await call("POST", `${base}/channels`, {
    plugin: "chan-mini",
    name: "Bot",
    agentId,
    config: { platformUrl: im.url, appId, appSecret: `${appId}-secret-0a1b2c3d` },
  });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  return { harness, connId: (ch.json.channel as { id: string }).id };
}

describe("channel long connections on the gateway role (dual replica)", () => {
  it("only the gateway replica holds the connection; the worker replica runs and replies once", async () => {
    const { harness, connId } = await setup([["api", "worker"], ["gateway"]], "cli_roles");
    const [workerReplica, gatewayReplica] = harness.replicas;

    const first = await waitFor(async () => im.active(connId)[0], 15_000, "long connection");
    expect(first.pid).toBe(gatewayReplica.pid);
    // Several scan / renew rounds: still a single holder, never the worker replica
    await sleep(LEASE_TTL_MS * 2);
    expect(im.maxConcurrent(connId)).toBe(1);
    expect(im.streams.filter((s) => s.connectionId === connId).map((s) => s.pid)).toEqual([
      gatewayReplica.pid,
    ]);

    const mine = () => im.sent.filter((s) => s.appId === "cli_roles");
    expect(im.push(connId, dm("m1", "u-owner", "echo:hello gateway"))).toBe(1);
    const reply = await waitFor(
      async () => mine().find((s) => im.finalText(s) === "hello gateway"),
      20_000,
      "reply",
    );
    // Outbound delivery stays on the worker role
    expect(reply.pid).toBe(workerReplica.pid);
    await sleep(1000);
    expect(mine().filter((s) => im.finalText(s) === "hello gateway")).toHaveLength(1);
  }, 120_000);

  it("replicas without the gateway role open no long connection", async () => {
    const { harness, connId } = await setup(
      [
        ["api", "worker"],
        ["api", "worker"],
      ],
      "cli_nogw",
    );
    const redis = new Redis(harness.redisUrl);
    cleanups.push(() => redis.disconnect());
    await sleep(SCAN_MS * 3 + 1000);
    expect(im.maxConcurrent(connId)).toBe(0);
    expect(im.streams.filter((s) => s.connectionId === connId)).toHaveLength(0);
    // Nobody even took the lease
    expect(await redis.exists(channelLeaseKey(connId))).toBe(0);
  }, 120_000);
});
