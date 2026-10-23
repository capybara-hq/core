import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeChannelServer,
  type Harness,
  startFakeChannelServer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Fair sharing of channel long connections across gateway replicas (E11-B), in separate processes:
 * 2 gateways split 4 connections 2 / 2 (`shareSlack: 0`), a third gateway brings it to some
 * permutation of 2 / 1 / 1, and after SIGKILLing the third every connection has a holder again
 * within one lease TTL plus one scan interval. A connection never has two live streams at once.
 * Lease and scan intervals are shortened (defaults 30s / 10s) to TTL 3s and a 300ms scan.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const LEASE_TTL_MS = 3000;
const SCAN_MS = 300;
const CONNECTIONS = 4;

let im: FakeChannelServer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;

beforeAll(async () => {
  im = await startFakeChannelServer();
}, 120_000);

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await im?.stop();
});

type Json = Record<string, unknown>;

/** Connections held per pid right now (from the fake IM server's live streams). */
function holders(ids: string[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of ids) {
    const live = im.active(id);
    if (live.length !== 1) continue;
    const pid = (live[0] as { pid: number }).pid;
    m.set(pid, (m.get(pid) ?? 0) + 1);
  }
  return m;
}

/** True when every connection has exactly one live stream and the per-pid counts match `want`. */
function split(ids: string[], want: Record<number, number> | number[]): boolean {
  if (!ids.every((id) => im.active(id).length === 1)) return false;
  const got = holders(ids);
  if (Array.isArray(want)) {
    return (
      JSON.stringify([...got.values()].sort()) === JSON.stringify([...want].sort()) &&
      got.size === want.length
    );
  }
  return (
    Object.entries(want).every(([pid, n]) => got.get(Number(pid)) === n) &&
    got.size === Object.keys(want).length
  );
}

describe("channel long connections: fair share across gateway replicas (dual replica)", () => {
  it("2 gateways hold 2 / 2, a third makes it 2 / 1 / 1, killing it hands its share back", async () => {
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, CHAN_MINI],
      config: {
        auth: { cookieSecure: false },
        http: { publicUrl: "https://cap.example" },
        channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: SCAN_MS, shareSlack: 0 },
      },
    });
    const harness = h;
    raw = createDb(harness.dbUrl, 3);
    const db = kernelDb(raw);

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

    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    expect(
      (await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
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
    expect((await call("PUT", `${base}/plugins/chan-mini`, { enabled: true })).status).toBe(200);
    const ids: string[] = [];
    for (let i = 0; i < CONNECTIONS; i++) {
      const ch = await call("POST", `${base}/channels`, {
        plugin: "chan-mini",
        name: `Bot ${i}`,
        agentId,
        config: {
          platformUrl: im.url,
          appId: `cli_share_${i}`,
          appSecret: `share-secret-0a1b2c${i}`,
        },
      });
      expect(ch.status, JSON.stringify(ch.json)).toBe(201);
      ids.push((ch.json.channel as { id: string }).id);
    }

    const [a, b] = harness.replicas;
    await waitFor(async () => split(ids, { [a.pid]: 2, [b.pid]: 2 }), 20_000, "2 / 2");

    const c = await harness.startExtraReplica(["gateway"]);
    await waitFor(async () => split(ids, [2, 1, 1]), 20_000, "2 / 1 / 1");
    expect(holders(ids).has(c.pid)).toBe(true);
    // Stable: several more scan rounds and no stream opens or closes
    const streams = im.streams.length;
    await sleep(SCAN_MS * 10);
    expect(im.streams.length).toBe(streams);
    expect(split(ids, [2, 1, 1])).toBe(true);

    const killedAt = Date.now();
    await c.kill();
    await waitFor(
      async () => split(ids, { [a.pid]: 2, [b.pid]: 2 }),
      LEASE_TTL_MS + SCAN_MS + 5_000,
      "the killed replica's share taken over",
    );
    // Lease expiry plus up to two scan rounds (one may start just before the lease frees up); the
    // margin covers the fake handshake, this test's polling and load on a busy runner
    expect(Date.now() - killedAt).toBeLessThanOrEqual(LEASE_TTL_MS + 2 * SCAN_MS + 1_500);
    for (const id of ids) expect(im.maxConcurrent(id)).toBe(1);
  }, 180_000);
});
