import { fileURLToPath } from "node:url";
import type { ChannelWebhookRequest, InboundEvent } from "@capybara-hq/plugin-sdk";
import {
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  type FakeChannelServer,
  fakeDm,
  fakeWebhookChallenge,
  fakeWebhookEvents,
  signFakeWebhook,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_CHANGED_TOPIC } from "../../src/channels/connections.service.js";
import { CHANNEL_QUEUE_NAME } from "../../src/channels/outbound.js";
import { ChannelWebhooks } from "../../src/channels/webhook.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Webhook inbound (F8 / F9) on one api+gateway kernel (no worker, so inbound jobs stay in the
 * queue and can be counted). Requests carry no session cookie and no CSRF header: the route is
 * outside the API guard (P-4); only the plugin's signature check stands between a request and
 * the queue.
 */

const FAKE_IM = fileURLToPath(new URL("../fixtures/plugins/fake-im/index.ts", import.meta.url));
const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const BASE_URL = "https://hooks.example.com";
const TOKEN = "webhook-token-4b7d9e21";
const MAX_BODY = 1_048_576;

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let im: FakeChannelServer;
let raw: ReturnType<typeof createDb>;
let queue: Queue;
let owner: Req;
let orgId: string;
let agentId: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "gateway"],
        plugins: [MODEL_FAKE, FAKE_IM, CHAN_MINI],
        pluginConfig: {
          "fake-im": { platformUrl: im.url, clientId: "c1", clientSecret: "client-secret-1" },
        },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: {
          scanIntervalMs: 100,
          leaseTtlMs: 2000,
          retryBaseMs: 200,
          webhookBaseUrl: `${BASE_URL}/`,
        },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
  await new AccountsService(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  for (const plugin of ["fake-im", "chan-mini"]) {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
      payload: {
        enabled: true,
        ...(plugin === "fake-im" && { config: { url: im.book("acme").url } }),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await queue?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const channels = () => `/api/v1/orgs/${orgId}/channels`;

async function createChannel(plugin: string, appId: string, webhookToken?: string) {
  const res = await owner({
    method: "POST",
    url: channels(),
    payload: {
      plugin,
      name: `${plugin} bot`,
      agentId,
      config: {
        platformUrl: im.url,
        appId,
        appSecret: `${appId}-secret-8c1d`,
        ...(webhookToken !== undefined && { webhookToken }),
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { channel: { id: string } }).channel.id;
}

const patch = (id: string, payload: Record<string, unknown>) =>
  owner({ method: "PATCH", url: `${channels()}/${id}`, payload });

/** A webhook call as the platform makes it: no cookie, no CSRF header. */
const hook = (id: string, body: string | Buffer, signature?: string) =>
  k.http.inject({
    method: "POST",
    url: `/channels/webhook/${id}`,
    headers: {
      "content-type": "application/json",
      ...(signature !== undefined && { [FAKE_WEBHOOK_SIGNATURE_HEADER]: signature }),
    },
    payload: body,
  });

const inboundJobs = async (connectionId: string) =>
  (
    await queue.getJobs(["waiting", "prioritized", "delayed", "active", "completed", "failed"])
  ).filter(
    (j) =>
      j.name === "inbound" && (j.data as { connectionId?: string }).connectionId === connectionId,
  );

describe("channel webhook route (single replica, api + gateway)", () => {
  let webhookConn: string;

  it("PATCH inboundMode webhook: the view carries the callback URL and the long connection drops", async () => {
    webhookConn = await createChannel("fake-im", "cli_hook", TOKEN);
    await waitFor(async () => im.active(webhookConn)[0], 15_000, "long connection");
    const before = (
      (await owner({ method: "GET", url: `${channels()}/${webhookConn}` })).json() as {
        channel: Record<string, unknown>;
      }
    ).channel;
    expect(before.inboundMode).toBe("long_connection");
    expect(before.webhookSupported).toBe(true);
    expect(before.webhookUrl).toBe(`${BASE_URL}/channels/webhook/${webhookConn}`);

    const seen: unknown[] = [];
    const unsubscribe = await k.bus.subscribe(CHANNEL_CHANGED_TOPIC, (p) => seen.push(p));
    try {
      const res = await patch(webhookConn, { inboundMode: "webhook" });
      expect(res.statusCode, res.body).toBe(200);
      const view = (res.json() as { channel: Record<string, unknown> }).channel;
      expect(view.inboundMode).toBe("webhook");
      expect(view.webhookUrl).toBe(`${BASE_URL}/channels/webhook/${webhookConn}`);
      await waitFor(
        async () =>
          seen.some(
            (p) =>
              (p as { connectionId?: string }).connectionId === webhookConn &&
              (p as { reconnect?: boolean }).reconnect === true,
          ) || undefined,
        5000,
        "channel.changed reconnect",
      );
    } finally {
      await unsubscribe();
    }
    await waitFor(
      async () => (im.active(webhookConn).length === 0 ? true : undefined),
      10_000,
      "long connection dropped",
    );
    // The supervisor no longer scans it: no reconnect over several rounds
    await new Promise((r) => setTimeout(r, 600));
    expect(im.active(webhookConn)).toHaveLength(0);
  });

  it("a signed DM is acked and enqueued once; redelivering the same messageId adds nothing", async () => {
    const body = fakeWebhookEvents([fakeDm("hook-m1", "u-1", "hello over webhook")]);
    const first = await hook(webhookConn, body, signFakeWebhook(body, TOKEN));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).toBe("ok");
    expect(await inboundJobs(webhookConn)).toHaveLength(1);
    const again = await hook(webhookConn, body, signFakeWebhook(body, TOKEN));
    expect(again.statusCode).toBe(200);
    expect(await inboundJobs(webhookConn)).toHaveLength(1);
  });

  it("a bad or missing signature → 401 and nothing enqueued", async () => {
    const body = fakeWebhookEvents([fakeDm("hook-forged", "u-1", "forged")]);
    const bad = await hook(webhookConn, body, signFakeWebhook(body, "wrong-token"));
    expect(bad.statusCode).toBe(401);
    const missing = await hook(webhookConn, body);
    expect(missing.statusCode).toBe(401);
    expect(await inboundJobs(webhookConn)).toHaveLength(1);
  });

  it("a URL verification challenge gets the plugin's response", async () => {
    const body = fakeWebhookChallenge("chal-123");
    const res = await hook(webhookConn, body, signFakeWebhook(body, TOKEN));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: "chal-123" });
  });

  it("any content type (or none) reaches the plugin as raw bytes", async () => {
    const body = fakeWebhookChallenge("chal-raw");
    for (const type of ["application/x-www-form-urlencoded", "text/plain", undefined]) {
      const res = await k.http.inject({
        method: "POST",
        url: `/channels/webhook/${webhookConn}`,
        headers: {
          [FAKE_WEBHOOK_SIGNATURE_HEADER]: signFakeWebhook(body, TOKEN),
          ...(type !== undefined && { "content-type": type }),
        },
        payload: body,
      });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(200);
      expect(res.json()).toEqual({ challenge: "chal-raw" });
    }
  });

  it("long_connection, disabled and unknown connections answer the same 404", async () => {
    const longConn = await createChannel("fake-im", "cli_long", TOKEN);
    const body = fakeWebhookEvents([fakeDm("hook-404", "u-1", "nobody home")]);
    const sig = signFakeWebhook(body, TOKEN);
    const asLong = await hook(longConn, body, sig);
    const unknown = await hook("6f1d2c3b-0a9e-4f8d-8c7b-6a5e4d3c2b1a", body, sig);
    const notUuid = await hook("not-a-uuid", body, sig);
    expect((await patch(webhookConn, { status: "disabled" })).statusCode).toBe(200);
    const disabled = await hook(webhookConn, body, sig);
    expect((await patch(webhookConn, { status: "active" })).statusCode).toBe(200);
    for (const res of [asLong, unknown, notUuid, disabled]) {
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("channel.webhook_not_found");
    }
    expect(new Set([asLong, unknown, notUuid, disabled].map((r) => r.body)).size).toBe(1);
    expect(await inboundJobs(longConn)).toHaveLength(0);
  });

  it("a body over channels.webhookMaxBodyBytes → 413; one at the limit reaches the plugin", async () => {
    const big = Buffer.alloc(MAX_BODY + 1, 0x61);
    const res = await hook(webhookConn, big, signFakeWebhook(big, TOKEN));
    expect(res.statusCode).toBe(413);
    expect(errCode(res)).toBe("payload_too_large");
    // Exactly the limit reaches the plugin (signed but not JSON → its 400)
    const atLimit = Buffer.alloc(MAX_BODY, 0x61);
    const ok = await hook(webhookConn, atLimit, signFakeWebhook(atLimit, TOKEN));
    expect(ok.statusCode).toBe(400);
  });

  it("PATCH inboundMode webhook for a plugin without webhook support → 409", async () => {
    const mini = await createChannel("chan-mini", "cli_mini");
    const view = (
      (await owner({ method: "GET", url: `${channels()}/${mini}` })).json() as {
        channel: Record<string, unknown>;
      }
    ).channel;
    expect(view.webhookSupported).toBe(false);
    expect(view.webhookUrl).toBeNull();
    const res = await patch(mini, { inboundMode: "webhook" });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("channel.webhook_unavailable");
  });

  it("switching back to long_connection reconnects and the webhook answers 404 again", async () => {
    expect((await patch(webhookConn, { inboundMode: "long_connection" })).statusCode).toBe(200);
    await waitFor(async () => im.active(webhookConn)[0], 15_000, "long connection again");
    const body = fakeWebhookEvents([fakeDm("hook-after", "u-1", "late")]);
    const res = await hook(webhookConn, body, signFakeWebhook(body, TOKEN));
    expect(res.statusCode).toBe(404);
  });

  it("without channels.webhookBaseUrl the switch → 409 and the view has no webhookUrl", async () => {
    // A second replica on the same PG / Redis whose config lacks the base URL
    const k2 = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["api"],
          plugins: [MODEL_FAKE, FAKE_IM, CHAN_MINI],
          pluginConfig: {
            "fake-im": { platformUrl: im.url, clientId: "c1", clientSecret: "client-secret-1" },
          },
          http: { port: 0, publicUrl: "https://cap.example" },
          auth: { cookieSecure: false },
        },
      ),
    );
    try {
      const conn = await createChannel("fake-im", "cli_nobase", TOKEN);
      const owner2 = await session(k2, "owner");
      const view = (
        (await owner2({ method: "GET", url: `${channels()}/${conn}` })).json() as {
          channel: Record<string, unknown>;
        }
      ).channel;
      expect(view.webhookSupported).toBe(true);
      expect(view.webhookUrl).toBeNull();
      const res = await owner2({
        method: "PATCH",
        url: `${channels()}/${conn}`,
        payload: { inboundMode: "webhook" },
      });
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe("channel.webhook_unavailable");
      // The route is not mounted without the gateway role
      const body = fakeWebhookEvents([]);
      const off = await k2.http.inject({
        method: "POST",
        url: `/channels/webhook/${webhookConn}`,
        headers: { "content-type": "application/json" },
        payload: body,
      });
      expect(off.statusCode).toBe(404);
    } finally {
      await k2.stop();
    }
  });
});

describe("ChannelWebhooks.handle", () => {
  const ID = "6f1d2c3b-0a9e-4f8d-8c7b-6a5e4d3c2b1a";
  const request: ChannelWebhookRequest = {
    method: "POST",
    headers: {},
    body: new Uint8Array(),
    receivedAt: 0,
  };
  const make = (onEvent: (id: string, e: InboundEvent) => Promise<void>) =>
    new ChannelWebhooks({
      connections: {
        row: async () => ({
          id: ID,
          orgId: "o1",
          plugin: "p",
          agentId: "a",
          unboundPolicy: "bind",
          status: "active",
          inboundMode: "webhook",
          tenantId: "t1",
          pluginEnabled: true,
        }),
        runtime: async () =>
          ({
            row: {} as never,
            config: {},
            channel: {
              webhook: {
                handle: async () => ({
                  kind: "events",
                  events: [fakeDm("x1", "u", "a"), fakeDm("x2", "u", "b")],
                  ack: { status: 200, body: "ok" },
                }),
              },
            },
          }) as never,
      },
      inbound: { onEvent },
      log: { warn: () => {} },
    });

  it("acks only after every onEvent resolved", async () => {
    const accepted: string[] = [];
    const res = await make(async (_id, e) => {
      accepted.push((e as { messageId: string }).messageId);
    }).handle(ID, request, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(accepted).toEqual(["x1", "x2"]);
  });

  it("any onEvent rejection → 503 so the platform redelivers", async () => {
    const res = await make(async (_id, e) => {
      if ((e as { messageId: string }).messageId === "x2") throw new Error("redis down");
    }).handle(ID, request, new AbortController().signal);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body ?? "{}").error.code).toBe("channel.webhook_retry");
  });
});
