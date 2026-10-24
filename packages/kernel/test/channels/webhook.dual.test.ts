import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  type FakeChannelServer,
  fakeDm,
  fakeWebhookEvents,
  type Harness,
  signFakeWebhook,
  startFakeChannelServer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Webhook inbound across roles (F9): replica 0 runs `api` + `worker`, replica 1 only `gateway`.
 * The webhook route exists only on the gateway replica; the worker replica runs the agent and
 * delivers the reply. Lease / scan intervals are shortened (defaults 30s / 10s).
 */

const FAKE_IM = fileURLToPath(new URL("../fixtures/plugins/fake-im/index.ts", import.meta.url));
const TOKEN = "dual-webhook-token-73c1";

let im: FakeChannelServer;
let h: Harness;
let raw: ReturnType<typeof createDb>;

beforeAll(async () => {
  im = await startFakeChannelServer();
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, FAKE_IM],
    roles: [["api", "worker"], ["gateway"]],
    pluginConfig: {
      "fake-im": { platformUrl: im.url, clientId: "c1", clientSecret: "client-secret-1" },
    },
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: {
        leaseTtlMs: 3000,
        scanIntervalMs: 300,
        webhookBaseUrl: "https://hooks.example.com",
      },
    },
  });
  raw = createDb(h.dbUrl, 3);
}, 120_000);

afterAll(async () => {
  await raw?.destroy();
  await h?.stop();
  await im?.stop();
});

type Json = Record<string, unknown>;

describe("channel webhook inbound (dual replica, api+worker / gateway)", () => {
  it("the gateway replica takes the webhook, the worker replies once; the api replica has no route", async () => {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await h.request(path, {
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
      await new AccountsService(kernelDb(raw)).createLocal({
        login: "owner",
        password: PW,
        displayName: "O",
      })
    ).id;
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
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES ('fake-im:t1', 'u-owner', ${ownerId})`.execute(raw);
    const en = await call("PUT", `${base}/extensions/fake-im`, {
      enabled: true,
      config: { url: im.book("acme").url },
    });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    const ch = await call("POST", `${base}/channels`, {
      plugin: "fake-im",
      name: "Bot",
      agentId: (ag.json.agent as { id: string }).id,
      config: {
        platformUrl: im.url,
        appId: "cli_dualhook",
        appSecret: "cli_dualhook-secret-5e6f",
        webhookToken: TOKEN,
      },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const connId = (ch.json.channel as { id: string }).id;
    const [, gateway] = h.replicas;

    // Long connection first (default mode), held by the gateway replica
    const stream = await waitFor(async () => im.active(connId)[0], 15_000, "long connection");
    expect(stream.pid).toBe(gateway.pid);

    const sw = await call("PATCH", `${base}/channels/${connId}`, { inboundMode: "webhook" });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    expect((sw.json.channel as Json).webhookUrl).toBe(
      `https://hooks.example.com/channels/webhook/${connId}`,
    );
    await waitFor(
      async () => (im.active(connId).length === 0 ? true : undefined),
      10_000,
      "long connection dropped",
    );
    await sleep(1000);
    expect(im.active(connId)).toHaveLength(0);

    const body = fakeWebhookEvents([fakeDm("dual-m1", "u-owner", "echo:hello webhook")]);
    const post = (index: number) =>
      h.requestTo(index, `/channels/webhook/${connId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FAKE_WEBHOOK_SIGNATURE_HEADER]: signFakeWebhook(body, TOKEN),
        },
        body,
      });
    const acked = await post(1);
    expect(acked.status).toBe(200);
    expect(await acked.text()).toBe("ok");

    const mine = () => im.sent.filter((s) => s.appId === "cli_dualhook");
    const reply = await waitFor(
      async () => mine().find((s) => im.finalText(s) === "hello webhook"),
      20_000,
      "reply",
    );
    // Runs and outbound delivery stay on the worker replica
    expect(reply.pid).toBe(h.replicas[0].pid);

    // A redelivery is acked but not processed again
    const again = await post(1);
    expect(again.status).toBe(200);
    await again.text();

    // The api + worker replica does not serve the webhook route
    const off = await post(0);
    expect(off.status).toBe(404);
    await off.text();

    await sleep(1500);
    expect(mine().filter((s) => im.finalText(s) === "hello webhook")).toHaveLength(1);
  }, 120_000);
});
