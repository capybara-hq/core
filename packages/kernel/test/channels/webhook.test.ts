import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ChannelWebhook,
  ChannelWebhookRequest,
  ChannelWebhookResult,
  ExtensionContext,
  InboundEvent,
  PluginSetupGuide,
} from "@capybara-hq/plugin-sdk";
import {
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  type FakeChannelServer,
  fakeDm,
  fakeExtensionEntry,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHANNEL_CHANGED_TOPIC } from "../../src/channels/connections.service.js";
import { CHANNEL_QUEUE_NAME } from "../../src/channels/outbound.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { InflightTracker } from "../../src/extensions/inflight.js";
import { setupGuideHash } from "../../src/extensions/plugin-guides.js";
import { KERNEL_BUS } from "../../src/infra/tokens.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { channelWebhooksFor } from "../helpers/channels.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Webhook inbound (F8 / F9) on one api+gateway kernel (no worker, so inbound jobs stay in the
 * queue and can be counted). Requests carry no session cookie and no CSRF header: the route is
 * outside the API guard (P-4); only the plugin's signature check stands between a request and
 * the queue.
 */

const FAKE_IM = fakeExtensionEntry("fake-im");
const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const BASE_URL = "https://hooks.example.com";
const TOKEN = "webhook-token-4b7d9e21";
const MAX_BODY = 1_048_576;

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let im: FakeChannelServer;
let raw: ReturnType<typeof createDb>;
let queue: Queue;
/**
 * The client the queue above uses. A queue given a client does not close it, so afterAll quits it
 * before Redis stops: an open client without an error listener reports "[ioredis] Unhandled error
 * event" on every reconnect, which can land after Vitest tore the worker down.
 */
const redisClients: Redis[] = [];
const redisClient = (): Redis => {
  const c = new Redis(rd.url);
  redisClients.push(c);
  return c;
};
let owner: Req;
let ownerId: string;
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
        extensions: [MODEL_FAKE, FAKE_IM, CHAN_MINI],
        extensionConfig: {
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
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: redisClient() });
  const o = await accountsFor(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
  ownerId = o.id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  for (const plugin of ["fake-im", "chan-mini"]) {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: {
        enabled: true,
        ...(plugin === "fake-im" && { config: { url: im.book("acme").url } }),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await k?.close();
  await queue?.close();
  await Promise.all(redisClients.splice(0).map((c) => c.quit()));
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
    const unsubscribe = await k.app
      .get<ExtensionContext["bus"]>(KERNEL_BUS)
      .subscribe(CHANNEL_CHANGED_TOPIC, (p) => seen.push(p));
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

  it("a malformed Content-Type → 415 before the plugin is called", async () => {
    const body = fakeWebhookChallenge("chal-bad-type");
    const res = await k.http.inject({
      method: "POST",
      url: `/channels/webhook/${webhookConn}`,
      headers: {
        [FAKE_WEBHOOK_SIGNATURE_HEADER]: signFakeWebhook(body, TOKEN),
        "content-type": "not a media type",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
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
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
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
          extensions: [MODEL_FAKE, FAKE_IM, CHAN_MINI],
          extensionConfig: {
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
      await k2.close();
    }
  });
});

// Plugin setup guides (spec 2026-11-08-plugin-setup-guides-design.md §6): a PATCH that switches
// the inbound mode re-baselines the guide ack only when it shows no drift, so switching modes there
// and back never clears the update notice; only the human guide-ack route does.
describe("setup guide ack across mode switches", () => {
  const GUIDE: PluginSetupGuide = {
    id: "app",
    place: "channel-connection",
    title: { en: "Create the app" },
    files: [
      {
        path: "./guides/s.yaml.tmpl",
        title: { en: "M" },
        language: "yaml",
        mode: "long_connection",
      },
      { path: "./guides/w.yaml.tmpl", title: { en: "M" }, language: "yaml", mode: "webhook" },
    ],
  };
  const files = (socket: string, webhook: string) => [
    { path: "guides/s.yaml.tmpl", size: 10, sha256: socket.repeat(64) },
    { path: "guides/w.yaml.tmpl", size: 10, sha256: webhook.repeat(64) },
  ];
  type Page = {
    guideAck: { guideId: string; version: string; hash: string; mode: string } | null;
    guideDrift: { from: string; to: string } | null;
  };
  const db = () => kernelDb(raw);
  const get = async (id: string): Promise<Page> => {
    const r = await owner({ method: "GET", url: `${channels()}/${id}` });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { channel: Page }).channel;
  };
  /** A fake-im catalog item at `version` (the extension itself comes from the startup config). */
  const seedVersion = async (itemId: string, version: string, f: ReturnType<typeof files>) => {
    await db()
      .insertInto("catalog_item_versions")
      .values({
        item_id: itemId,
        version,
        manifest: JSON.stringify({
          schemaVersion: 1,
          name: "fake-im",
          version,
          publisher: "Acme",
          description: "IM",
          setupGuides: [GUIDE],
        }),
        source: "file",
        source_ref: "upload",
        object_prefix: null,
        files: JSON.stringify(f),
        size: 1000,
      })
      .execute();
    await db()
      .updateTable("catalog_items")
      .set({ latest_version: version })
      .where("id", "=", itemId)
      .execute();
  };
  let itemId: string;

  beforeAll(async () => {
    itemId = randomUUID();
    await db()
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "fake-im",
        package_name: "@acme/plugin-fake-im",
        publisher: "Acme",
        description: "IM",
        latest_version: "1.0.0",
        policy: "allow",
        disabled: false,
      })
      .execute();
  });

  afterAll(async () => {
    await db().deleteFrom("catalog_item_versions").where("item_id", "=", itemId).execute();
    await db().deleteFrom("catalog_items").where("id", "=", itemId).execute();
  });

  const ack = (id: string, hash: string) =>
    owner({ method: "POST", url: `${channels()}/${id}/guide-ack`, payload: { hash } });

  it("a switch without drift re-baselines; with drift the notice survives there and back", async () => {
    await seedVersion(itemId, "1.0.0", files("a", "b"));
    const id = await createChannel("fake-im", "cli_guide", TOKEN);
    expect((await get(id)).guideAck).toMatchObject({ version: "1.0.0", mode: "long_connection" });

    // no drift: the ack moves to the webhook guide
    expect((await patch(id, { inboundMode: "webhook" })).statusCode).toBe(200);
    let page = await get(id);
    expect(page.guideAck).toEqual({
      guideId: "app",
      version: "1.0.0",
      hash: setupGuideHash(GUIDE, files("a", "b"), "webhook"),
      mode: "webhook",
    });
    expect(page.guideDrift).toBeNull();

    // 1.1.0 changes the webhook template: drift; switching away and back keeps the old ack
    await seedVersion(itemId, "1.1.0", files("a", "c"));
    const drifted = await get(id);
    expect(drifted.guideDrift).toEqual({ from: "1.0.0", to: "1.1.0" });
    expect((await patch(id, { inboundMode: "long_connection" })).statusCode).toBe(200);
    page = await get(id);
    expect(page.guideAck).toEqual(drifted.guideAck);
    expect(page.guideDrift).toEqual({ from: "1.0.0", to: "1.1.0" });
    expect((await patch(id, { inboundMode: "webhook" })).statusCode).toBe(200);
    page = await get(id);
    expect(page.guideAck).toEqual(drifted.guideAck);
    expect(page.guideDrift).toEqual({ from: "1.0.0", to: "1.1.0" });

    // the ack's mode differs from the connection's: the confirm button posts the hash of the guide
    // shown for the current mode, which is accepted and clears the notice
    expect((await patch(id, { inboundMode: "long_connection" })).statusCode).toBe(200);
    expect((await get(id)).guideAck?.mode).toBe("webhook");
    const shown = setupGuideHash(GUIDE, files("a", "c"), "long_connection");
    const confirmed = await ack(id, shown);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    page = await get(id);
    expect(page.guideAck).toEqual({
      guideId: "app",
      version: "1.1.0",
      hash: shown,
      mode: "long_connection",
    });
    expect(page.guideDrift).toBeNull();
    expect((await owner({ method: "DELETE", url: `${channels()}/${id}` })).statusCode).toBe(204);
  });

  it("the Platform tool's channels.update keeps a drifted ack too", async () => {
    await seedVersion(itemId, "2.0.0", files("e", "f"));
    const id = await createChannel("fake-im", "cli_guide_op", TOKEN);
    await seedVersion(itemId, "2.1.0", files("g", "f"));
    const before = await get(id);
    expect(before.guideDrift).toEqual({ from: "2.0.0", to: "2.1.0" });
    const update = k.app.get(PlatformOperations).get("channels.update");
    if (update === null) throw new Error("no operation channels.update");
    const ctx = {
      orgId,
      actorAccountId: ownerId,
      agentId,
      conversationId: randomUUID(),
      runId: randomUUID(),
      signal: new AbortController().signal,
    };
    for (const inboundMode of ["webhook", "long_connection"]) {
      await update.run(update.input.parse({ connectionId: id, inboundMode }), ctx);
      const page = await get(id);
      expect(page.guideAck).toEqual(before.guideAck);
      expect(page.guideDrift).toEqual({ from: "2.0.0", to: "2.1.0" });
    }
    expect(
      (await ack(id, setupGuideHash(GUIDE, files("g", "f"), "long_connection"))).statusCode,
    ).toBe(200);
    expect((await get(id)).guideDrift).toBeNull();
    expect((await owner({ method: "DELETE", url: `${channels()}/${id}` })).statusCode).toBe(204);
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
  const twoEvents = async (): Promise<ChannelWebhookResult> => ({
    kind: "events",
    events: [fakeDm("x1", "u", "a"), fakeDm("x2", "u", "b")],
    ack: { status: 200, body: "ok" },
  });
  const make = (
    opts: {
      handle?: ChannelWebhook["handle"];
      runtime?: () => Promise<unknown>;
      onEvent?: (id: string, e: InboundEvent) => Promise<void>;
      handleTimeoutMs?: number;
      inflight?: InflightTracker;
    } = {},
  ) => {
    let runtimeCalls = 0;
    const webhooks = channelWebhooksFor({
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
        runtime: (async () => {
          runtimeCalls++;
          if (opts.runtime) return opts.runtime();
          return {
            row: {},
            config: {},
            channel: { webhook: { handle: opts.handle ?? twoEvents } },
            ...(opts.inflight !== undefined && { inflight: opts.inflight }),
          };
        }) as never,
      },
      inbound: { onEvent: opts.onEvent ?? (async () => {}) },
      log: { warn: () => {} },
      ...(opts.handleTimeoutMs !== undefined && { handleTimeoutMs: opts.handleTimeoutMs }),
    });
    return {
      webhooks,
      call: () => webhooks.handle(ID, request, new AbortController().signal),
      runtimeCalls: () => runtimeCalls,
    };
  };
  const code = (res: { body?: string }) => JSON.parse(res.body ?? "{}").error?.code;

  it("acks only after every onEvent resolved, waiting on a slow one", async () => {
    const accepted: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { call } = make({
      onEvent: async (_id, e) => {
        const id = (e as { messageId: string }).messageId;
        if (id === "x2") await gate;
        accepted.push(id);
      },
    });
    let settled = false;
    const pending = call().then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(accepted).toEqual(["x1"]);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(accepted).toEqual(["x1", "x2"]);
  });

  it("any onEvent rejection → 503 so the platform redelivers", async () => {
    const res = await make({
      onEvent: async (_id, e) => {
        if ((e as { messageId: string }).messageId === "x2") throw new Error("redis down");
      },
    }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("channel.webhook_retry");
  });

  it("a plugin that ignores its signal → 503 at the deadline", async () => {
    let aborted = false;
    const started = Date.now();
    const res = await make({
      handleTimeoutMs: 100,
      handle: ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("channel.webhook_retry");
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an onEvent stuck past the deadline (Redis reconnecting) → 503", async () => {
    const res = await make({
      handleTimeoutMs: 100,
      onEvent: () => new Promise(() => {}),
    }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("channel.webhook_retry");
  });

  it("a plugin that throws, or returns an invalid result → 500", async () => {
    const thrown = await make({
      handle: async () => {
        throw new Error("boom");
      },
    }).call();
    expect(thrown.status).toBe(500);
    expect(code(thrown)).toBe("internal");
    const invalid = await make({
      handle: async () => ({ kind: "nonsense" }) as unknown as ChannelWebhookResult,
    }).call();
    expect(invalid.status).toBe(500);
    const noArray = await make({
      handle: async () =>
        ({ kind: "events", events: "x", ack: { status: 200 } }) as unknown as ChannelWebhookResult,
    }).call();
    expect(noArray.status).toBe(500);
  });

  it("reject maps to 400 / 401 / 403 with generic codes", async () => {
    for (const [status, want] of [
      [403, "forbidden"],
      [401, "auth.required"],
      [400, "validation_failed"],
    ] as const) {
      const res = await make({ handle: async () => ({ kind: "reject", status }) }).call();
      expect(res.status).toBe(status);
      expect(code(res)).toBe(want);
    }
  });

  it("drops framing / cookie headers and always sets the security headers", async () => {
    const res = await make({
      handle: async () => ({
        kind: "respond",
        response: {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "Set-Cookie": "a=b",
            "content-length": "999",
            "X-Content-Type-Options": "sniff-away",
            "content-security-policy": "default-src *",
          },
          body: "hi",
        },
      }),
    }).call();
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({
      "content-type": "text/plain",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
    expect(res.body).toBe("hi");
    // Kernel-made errors carry them too
    const err = await make({ handle: async () => ({ kind: "reject", status: 401 }) }).call();
    expect(err.headers?.["x-content-type-options"]).toBe("nosniff");
  });

  it("a running handle counts toward the plugin's in-flight calls: drain waits for it", async () => {
    const inflight = new InflightTracker("p");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { call } = make({
      inflight,
      handle: async () => {
        await gate;
        return { kind: "respond", response: { status: 200, body: "ok" } };
      },
    });
    const pending = call();
    await vi.waitFor(() => expect(inflight.size).toBe(1));
    let drained: string | undefined;
    const drain = inflight.drain(5_000).then((r) => {
      drained = r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(drained).toBeUndefined();
    release();
    expect((await pending).status).toBe(200);
    await drain;
    expect(drained).toBe("drained");
    expect(inflight.size).toBe(0);
  });

  it("a plugin instance being revoked → 503 extension.unavailable without calling handle", async () => {
    const inflight = new InflightTracker("p");
    inflight.close();
    let called = false;
    const res = await make({
      inflight,
      handle: async () => {
        called = true;
        return twoEvents();
      },
    }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("extension.unavailable");
    expect(called).toBe(false);
  });

  it("a handle still running past the drain is aborted → 503 so the platform retries", async () => {
    const inflight = new InflightTracker("p");
    let seen: AbortSignal | undefined;
    const { call } = make({
      inflight,
      handle: async ({ signal }) => {
        seen = signal;
        return new Promise<never>(() => {});
      },
    });
    const pending = call();
    await vi.waitFor(() => expect(inflight.size).toBe(1));
    expect(await inflight.drain(20)).toBe("timeout");
    inflight.abort();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(code(res)).toBe("channel.webhook_retry");
    expect(seen?.aborted).toBe(true);
    expect(inflight.size).toBe(0);
  });

  it("plugin not loaded on this gateway → 503 extension.unavailable", async () => {
    const res = await make({
      runtime: async () => {
        throw new ApiError("extension.not_found", "Extension p does not provide a channel");
      },
    }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("extension.unavailable");
  });

  it("a slow runtime lookup on a cache miss → 503 at the deadline", async () => {
    const res = await make({ handleTimeoutMs: 100, runtime: () => new Promise(() => {}) }).call();
    expect(res.status).toBe(503);
    expect(code(res)).toBe("channel.webhook_retry");
  });

  it("a slow connection row lookup → 503 at the deadline", async () => {
    const webhooks = channelWebhooksFor({
      connections: { row: () => new Promise(() => {}), runtime: (async () => ({})) as never },
      inbound: { onEvent: async () => {} },
      log: { warn: () => {} },
      handleTimeoutMs: 100,
    });
    const res = await webhooks.handle(ID, request, new AbortController().signal);
    expect(res.status).toBe(503);
  });

  it("a runtime fetched across invalidateAll is used once but not cached", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const { webhooks, call } = make({
      runtime: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return { row: {}, config: {}, channel: { webhook: { handle: twoEvents } } };
      },
    });
    const pending = call();
    await new Promise((r) => setTimeout(r, 20));
    webhooks.invalidateAll(); // a plugin instance changed mid-fetch
    release();
    expect((await pending).status).toBe(200);
    await call();
    expect(calls).toBe(2);
    await call();
    expect(calls).toBe(2);
  });

  it("caches the runtime between requests until invalidated", async () => {
    const { webhooks, call, runtimeCalls } = make();
    await call();
    await call();
    expect(runtimeCalls()).toBe(1);
    webhooks.invalidate(ID);
    await call();
    expect(runtimeCalls()).toBe(2);
    webhooks.invalidateAll();
    await call();
    expect(runtimeCalls()).toBe(3);
  });
});
