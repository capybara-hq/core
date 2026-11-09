import {
  type FakeChannelServer,
  fakeExtensionEntry,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webhookSeenKey } from "../../src/channels/webhook.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import {
  connectionActiveResult,
  KERNEL_CHECK_TEXTS,
  publicUrlCheck,
  webhookPublicCheck,
  webhookReceivedResult,
} from "../../src/setup/kernel-checks.js";
import { SetupCheckRegistry } from "../../src/setup/setup-check-registry.js";
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
} from "../helpers/runs.js";
import { seedFakeImGuideItem } from "../helpers/setup-guides.js";

// The kernel's channel-connection checks (spec 2026-11-09-setup-guides-v2-design.md §10.6, plan
// task 11): `capybara:public-url`, `webhook-public`, `webhook-received` (the gateway's Redis
// marker) and `connection-active` (its `last_error` reused only redacted and validated), through
// the same routes and pipeline as plugin checks.

const FAKE_IM = fakeExtensionEntry("fake-im");
const SECRET = "app-secret-3a9d0c7e51";

const DOC = [
  "# Create the fake IM app",
  "",
  "::: mode long_connection",
  "```yaml",
  "socket: true",
  "```",
  "",
  "::check capybara:public-url The public URL is set",
  "::check capybara:connection-active The connection runs",
  ":::",
  "",
  "::: mode webhook",
  "```yaml",
  "webhook: true",
  "```",
  "",
  "::check capybara:webhook-public Webhooks reach Capybara",
  "::check capybara:webhook-received A webhook arrived",
  "::check capybara:connection-active The connection runs",
  ":::",
  "",
].join("\n");

type State = { status: string; reason?: { en: string; zh?: string }; fix?: { en: string } };

const cfg = (o: { publicUrl?: string; webhookBaseUrl?: string; loopback?: boolean } = {}) =>
  ({
    http: { publicUrl: o.publicUrl },
    channels: { webhookBaseUrl: o.webhookBaseUrl },
    tools: { oauthAllowInsecureLoopback: o.loopback ?? false },
  }) as unknown as KernelConfig;

describe("kernel check results (pure)", () => {
  it("capybara:public-url: ok when set, failing with the super admin fix otherwise", () => {
    expect(publicUrlCheck(cfg({ publicUrl: "https://cap.example" })).status).toBe("ok");
    expect(publicUrlCheck(cfg())).toEqual({
      status: "failing",
      reason: KERNEL_CHECK_TEXTS.publicUrlMissing,
      fix: KERNEL_CHECK_TEXTS.publicUrlFix,
    });
  });

  it("capybara:webhook-public: only an https channels.webhookBaseUrl is public", () => {
    expect(webhookPublicCheck(cfg({ webhookBaseUrl: "https://hooks.example" })).status).toBe("ok");
    // unset (http.publicUrl is not what webhook URLs are built from), http, loopback http
    for (const c of [
      cfg({ publicUrl: "https://cap.example" }),
      cfg({ webhookBaseUrl: "http://hooks.example" }),
      cfg({ webhookBaseUrl: "http://127.0.0.1:9", loopback: true }),
    ]) {
      const r = webhookPublicCheck(c);
      expect(r.status).toBe("failing");
      expect(r.fix).toEqual(KERNEL_CHECK_TEXTS.webhookBaseFix);
    }
  });

  it("capybara:webhook-received: unknown without a marker (or a garbled one), ok with its time", () => {
    expect(webhookReceivedResult(null)).toEqual({
      status: "unknown",
      reason: KERNEL_CHECK_TEXTS.webhookNone,
    });
    expect(webhookReceivedResult("not a time").status).toBe("unknown");
    const r = webhookReceivedResult("2026-11-09T10:00:00.000Z");
    expect(r.status).toBe("ok");
    expect(r.reason?.en).toContain("2026-11-09T10:00:00.000Z");
  });

  it("capybara:connection-active: states and last_error handling", () => {
    const row = { status: "active", botUserId: "B1", lastError: null };
    expect(connectionActiveResult(row, []).status).toBe("ok");
    expect(connectionActiveResult({ ...row, botUserId: null }, []).status).toBe("unknown");
    expect(connectionActiveResult(undefined, []).status).toBe("unknown");
    expect(connectionActiveResult({ ...row, status: "disabled" }, [])).toEqual({
      status: "failing",
      reason: KERNEL_CHECK_TEXTS.connectionDisabled,
      fix: KERNEL_CHECK_TEXTS.connectionEnableFix,
    });
    // the error, redacted over the whole text before it is cut
    const long = `connect failed: ${SECRET} ${"x".repeat(400)}`;
    const failed = connectionActiveResult({ ...row, status: "error", lastError: long }, [SECRET]);
    expect(failed.status).toBe("failing");
    expect(failed.reason?.en).toContain("[REDACTED]");
    expect(failed.reason?.en).not.toContain(SECRET);
    expect((failed.reason?.en.length ?? 0) <= 300).toBe(true);
    // a secret cut by the length limit would leave a prefix: redaction runs first
    const tail = `${"y".repeat(195)}${SECRET}`;
    const cut = connectionActiveResult({ ...row, lastError: tail }, [SECRET]);
    expect(cut.reason?.en).not.toContain(SECRET.slice(0, 5));
    // bidi, control, separators, lone surrogates: the error is left out, the generic reason stays
    for (const bad of ["evil ‮ txt", "a\u0007b", "line break", "half \ud800"]) {
      expect(connectionActiveResult({ ...row, status: "error", lastError: bad }, [])).toEqual({
        status: "failing",
        reason: KERNEL_CHECK_TEXTS.connectionFailed,
        fix: KERNEL_CHECK_TEXTS.connectionFix,
      });
    }
    // an active connection with a recorded failure is failing too
    expect(connectionActiveResult({ ...row, lastError: "delivery failed: 401" }, []).status).toBe(
      "failing",
    );
  });
});

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let im: FakeChannelServer;
let owner: Req;
let orgId: string;
let agentId: string;
let itemId: string;
const lines: string[] = [];

describe("kernel channel checks over the routes", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    im = await startFakeChannelServer();
    k = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["api", "worker"],
          extensions: [MODEL_FAKE, FAKE_IM],
          extensionConfig: {
            "fake-im": {
              platformUrl: im.url,
              clientId: "c1",
              clientSecret: "deploy-secret-0b4e7a",
            },
          },
          http: { port: 0, publicUrl: "https://cap.example" },
          channels: { webhookBaseUrl: "https://hooks.example.com" },
          auth: { cookieSecure: false },
        },
      ),
      { env: {}, logger: createLogger("warn", { write: (l) => lines.push(l) }) },
    );
    raw = createDb(pgc.url, 3);
    db = kernelDb(raw);
    redis = new Redis(rd.url);
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    owner = await session(k, "owner");
    orgId = await createOrg(owner);
    agentId = await createAgent(owner, orgId);
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/fake-im`,
      payload: { enabled: true, config: { url: im.book(orgId).url } },
    });
    expect(en.statusCode, en.body).toBe(200);
    itemId = await seedFakeImGuideItem(db, DOC);
  }, 120_000);

  afterAll(async () => {
    await k?.close();
    await im?.stop();
    redis?.disconnect();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  beforeEach(async () => {
    const keys = [
      ...(await redis.keys("capk:setup-check*")),
      ...(await redis.keys("capk:channel-webhook-seen*")),
    ];
    if (keys.length > 0) await redis.del(...keys);
    lines.length = 0;
  });

  async function connection(): Promise<string> {
    const r = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "fake-im",
        name: "Bot",
        agentId,
        config: { platformUrl: im.url, appId: "cli_kernel", appSecret: SECRET },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { channel: { id: string } }).channel.id;
  }

  async function run(check: string, connectionId: string, mode?: string): Promise<State> {
    const r = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog/${itemId}/guides/fake-im-app/checks/${check}/run`,
      payload: { connectionId, ...(mode !== undefined && { mode }) },
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { result: State }).result;
  }

  it("registers the eight kernel checks once, at module init", () => {
    const reg = k.app.get(SetupCheckRegistry);
    for (const id of [
      "capybara:public-url",
      "capybara:webhook-public",
      "capybara:webhook-received",
      "capybara:connection-active",
      "capybara:oauth-client",
      "capybara:connector-tools",
      "capybara:connector-connected",
      "capybara:oauth-token-endpoint",
    ]) {
      expect(reg.resolve("fake-im", id)?.source, id).toBe("kernel");
    }
  });

  it("public-url and webhook-public answer from the config", async () => {
    const id = await connection();
    expect((await run("capybara:public-url", id)).status).toBe("ok");
    expect(await run("capybara:webhook-public", id, "webhook")).toMatchObject({
      status: "ok",
      reason: KERNEL_CHECK_TEXTS.webhookPublic,
    });
  });

  it("webhook-received: unknown before the gateway's marker, ok after it", async () => {
    const id = await connection();
    expect(await run("capybara:webhook-received", id, "webhook")).toMatchObject({
      status: "unknown",
      reason: KERNEL_CHECK_TEXTS.webhookNone,
    });
    await redis.set(webhookSeenKey(id), "2026-11-09T08:00:00.000Z", "EX", 60);
    await redis.del(...(await redis.keys("capk:setup-check*")));
    const r = await run("capybara:webhook-received", id, "webhook");
    expect(r.status).toBe("ok");
    expect(r.reason?.en).toContain("2026-11-09T08:00:00.000Z");
  });

  it("connection-active: ok when active; last_error redacted by the connection's secrets", async () => {
    const id = await connection();
    expect(await run("capybara:connection-active", id)).toMatchObject({
      status: "ok",
      reason: KERNEL_CHECK_TEXTS.connectionActive,
    });
    // a failure text that carries the stored secret (written before redaction existed)
    await db
      .updateTable("channel_connections")
      .set({ status: "error", last_error: `connect failed with ${SECRET}` })
      .where("id", "=", id)
      .execute();
    await redis.del(...(await redis.keys("capk:setup-check*")));
    const failing = await run("capybara:connection-active", id);
    expect(failing.status).toBe("failing");
    expect(failing.reason?.en).toBe(
      "The connection reported an error: connect failed with [REDACTED]",
    );
    expect(failing.fix).toEqual(KERNEL_CHECK_TEXTS.connectionFix);
    const cached = await redis.get(
      (await redis.keys("capk:setup-check:*connection-active*"))[0] ?? "",
    );
    expect(cached).not.toBeNull();
    expect(cached).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
    // a bidi override in last_error: left out, the generic reason stays
    await db
      .updateTable("channel_connections")
      .set({ last_error: "evil ‮ gnp.exe" })
      .where("id", "=", id)
      .execute();
    await redis.del(...(await redis.keys("capk:setup-check*")));
    expect(await run("capybara:connection-active", id)).toMatchObject({
      status: "failing",
      reason: KERNEL_CHECK_TEXTS.connectionFailed,
    });
  });

  it("connection-active: a deployment secret across the 200 character cut leaves no prefix", async () => {
    const id = await connection();
    // the plugin's deployment secret (`clientSecret`, not a connection field) straddles the cut:
    // redacted before cutting, so no partial value survives that later redaction cannot match
    await db
      .updateTable("channel_connections")
      .set({ status: "error", last_error: `${"x".repeat(190)}deploy-secret-0b4e7a tail` })
      .where("id", "=", id)
      .execute();
    const failing = await run("capybara:connection-active", id);
    expect(failing.status).toBe("failing");
    expect(failing.reason?.en).not.toContain("deploy-se");
    expect(failing.reason?.en).toContain("[REDACTED]");
  });
});
