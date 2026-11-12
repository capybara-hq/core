import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminAttention } from "../../src/admin/overview.service.js";
import { type CatalogItemView, CatalogService } from "../../src/catalog/catalog.service.js";
import {
  MarketplacesService,
  type MarketplaceView,
} from "../../src/catalog/marketplaces.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionAdmin } from "../../src/extensions/admin-view.js";
import type { AdminExtensionView } from "../../src/extensions/permission-view.js";
import { PlatformInboxService } from "../../src/inbox/platform-inbox.service.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { QUEUE_LOST_JOBS_KEY, QueueLostJobs } from "../../src/runtime/queue-lost-jobs.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE_B } from "../helpers/model-plugins.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * `GET /api/v1/admin/overview/attention` and the overview's `attentionTotal` (admin overview spec
 * §4.1, §5.2, §9): extensions by reason category, platform plugins with a newer marketplace
 * version, model providers by problem; capped at 20 with `more`; a failing source is named in
 * `unavailable`; never an error text or a replica detail.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
let k: TestKernel;
let root: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  redis = new Redis(rd.url);
  resetEvalModel();
  // the eval provider's list fails from the first read on
  evalModelState().listFails = true;
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [
          MODEL_FAKE_B,
          fixture("model-eval"),
          fixture("model-embed-probe"),
          fixture("badconfig"),
        ],
      },
    ),
  );
  await accountsFor(kernelDb(raw)).createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    superAdmin: true,
  });
  root = await session(k, "root");
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  resetEvalModel();
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function attention(): Promise<AdminAttention> {
  const r = await root({ method: "GET", url: "/api/v1/admin/overview/attention" });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as AdminAttention;
}

/** Every key at any depth of `v`. */
const keysOf = (v: unknown): string[] =>
  v === null || typeof v !== "object"
    ? []
    : Array.isArray(v)
      ? v.flatMap(keysOf)
      : Object.entries(v).flatMap(([key, x]) => [key, ...keysOf(x)]);

const view = (name: string, over: Partial<AdminExtensionView>) =>
  ({
    name,
    displayName: null,
    icon: null,
    status: "enabled",
    configValid: true,
    replicas: [{ detail: "raw replica detail sk-SECRET" }],
    ...over,
  }) as unknown as AdminExtensionView;

/** Catalog item ids are uuids (the icon lookup reads them from PG). */
const ITEM_1 = "6f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b61";

const item = (over: Partial<CatalogItemView>) =>
  ({
    id: ITEM_1,
    name: "crm",
    displayName: { zh: "客户", en: "CRM" },
    owner: { kind: "platform" },
    latestVersion: "1.2.0",
    latestMarketplaceVersion: "1.3.0",
    newerInMarketplace: true,
    marketplaceId: "official",
    ...over,
  }) as unknown as CatalogItemView;

describe("GET /api/v1/admin/overview/attention", { timeout: 60_000 }, () => {
  it("lists real extensions and providers by category, without error text", async () => {
    const a = await attention();
    // a config-declared extension whose setup throws fails the start, so load_failed is covered
    // through the status mapping below
    expect(a.extensions).toEqual([
      {
        name: "badconfig",
        displayName: null,
        icon: null,
        status: "pending_config",
        reason: "config",
      },
    ]);
    expect(a.providers).toEqual([
      { plugin: "model-eval", displayName: null, icon: null, problem: "list_failed" },
      { plugin: "model-embed-probe", displayName: null, icon: null, problem: "no_chat_model" },
    ]);
    expect(a.updates).toEqual([]);
    expect(a.more).toEqual({ extensions: 0, updates: 0, providers: 0, outbox: 0, queue: 0 });
    expect(a.outbox).toEqual([]);
    expect(a.queue).toEqual([]);
    expect(a.unavailable).toEqual([]);
    // privacy (spec §9): categories only
    const keys = keysOf(a);
    for (const banned of ["detail", "error", "message", "replicas"]) {
      expect(keys).not.toContain(banned);
    }
    expect(JSON.stringify(a)).not.toContain("upstream down");
  });

  it("maps every status to its reason; enabled with an invalid config is config", async () => {
    vi.spyOn(k.app.get(ExtensionAdmin), "list").mockResolvedValue([
      view("a", { status: "pending_config" }),
      view("b", { status: "failed" }),
      view("c", { status: "pending_approval" }),
      view("d", { status: "dependency" }),
      view("e", { status: "conflict" }),
      view("f", { status: "converging" }),
      view("g", { status: "pending_migration" }),
      view("h", { status: "legacy_format" }),
      view("i", { status: "enabled", configValid: false }),
      view("j", { status: "enabled" }),
      view("k", { status: "disabled", configValid: false }),
    ]);
    const a = await attention();
    expect(a.extensions.map((e) => [e.name, e.status, e.reason])).toEqual([
      ["a", "pending_config", "config"],
      ["b", "failed", "load_failed"],
      ["c", "pending_approval", "approval"],
      ["d", "dependency", "dependency"],
      ["e", "conflict", "conflict"],
      ["f", "converging", "converging"],
      ["g", "pending_migration", "converging"],
      ["h", "legacy_format", "legacy_format"],
      ["i", "enabled", "config"],
    ]);
    expect(JSON.stringify(a)).not.toContain("sk-SECRET");
  });

  it("caps each list at 20 and counts the rest in more", async () => {
    vi.spyOn(k.app.get(ExtensionAdmin), "list").mockResolvedValue(
      Array.from({ length: 23 }, (_, n) => view(`x-${n}`, { status: "failed" })),
    );
    const a = await attention();
    expect(a.extensions).toHaveLength(20);
    expect(a.more.extensions).toBe(3);
  });

  it("lists platform plugins with a newer marketplace version, with both versions", async () => {
    vi.spyOn(k.app.get(MarketplacesService), "list").mockResolvedValue([
      { id: "official", name: "Capybara Official" } as MarketplaceView,
    ]);
    vi.spyOn(k.app.get(CatalogService), "page").mockResolvedValue({
      items: [
        item({}),
        item({
          id: "6f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b62",
          name: "same",
          newerInMarketplace: false,
        }),
        item({
          id: "6f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b63",
          name: "theirs",
          owner: { kind: "org", orgId: "o", name: "Acme" },
        }),
      ],
      nextOffset: null,
    });
    const a = await attention();
    expect(a.updates).toEqual([
      {
        itemId: ITEM_1,
        name: "crm",
        displayName: { zh: "客户", en: "CRM" },
        icon: null,
        version: "1.2.0",
        marketplaceVersion: "1.3.0",
        marketplaceId: "official",
        marketplaceName: "Capybara Official",
      },
    ]);
    expect(a.unavailable).toEqual([]);
  });

  it("a source that fails is named in unavailable; the other lists stay", async () => {
    vi.spyOn(k.app.get(ProviderRegistry), "listWithStatus").mockRejectedValue(
      new Error("registry exploded: sk-SECRET"),
    );
    const r = await root({ method: "GET", url: "/api/v1/admin/overview/attention" });
    expect(r.statusCode).toBe(200);
    const a = r.json() as AdminAttention;
    expect(a.providers).toEqual([]);
    expect(a.unavailable).toEqual(["providers"]);
    expect(a.extensions.length).toBeGreaterThan(0);
    expect(r.body).not.toContain("sk-SECRET");
  });
});

describe("the run queue's lost jobs (transactional outbox spec §8.3)", { timeout: 60_000 }, () => {
  it("lists one queue_lost_jobs item with the count and the last loss, counted in attentionTotal", async () => {
    await redis.del(QUEUE_LOST_JOBS_KEY);
    expect((await attention()).queue).toEqual([]);
    const before = (await root({ method: "GET", url: "/api/v1/admin/overview" })).json() as {
      attentionTotal: number;
    };
    try {
      // what the run-orphan-check reports for two queued runs whose jobs the queue lost
      await k.app.get(QueueLostJobs).report(2);
      const a = await attention();
      expect(a.queue).toEqual([{ kind: "queue_lost_jobs", count: 2, lastAt: expect.any(String) }]);
      expect(Number.isNaN(Date.parse(a.queue[0]?.lastAt ?? ""))).toBe(false);
      expect(a.more.queue).toBe(0);
      expect(a.unavailable).toEqual([]);
      // a later loss adds to the count
      await k.app.get(QueueLostJobs).report(1);
      expect((await attention()).queue[0]?.count).toBe(3);
      const after = (await root({ method: "GET", url: "/api/v1/admin/overview" })).json() as {
        attentionTotal: number;
      };
      expect(after.attentionTotal).toBe(before.attentionTotal + 1);
      // it expires a week after the last loss
      expect(await redis.ttl(QUEUE_LOST_JOBS_KEY)).toBeGreaterThan(6 * 24 * 3600);
    } finally {
      await redis.del(QUEUE_LOST_JOBS_KEY);
    }
  });
});

describe("GET /api/v1/admin/overview attentionTotal", { timeout: 60_000 }, () => {
  it("is the inbox total plus every attention list counted in full", async () => {
    vi.spyOn(k.app.get(PlatformInboxService), "count").mockResolvedValue(4);
    vi.spyOn(k.app.get(ExtensionAdmin), "list").mockResolvedValue(
      Array.from({ length: 23 }, (_, n) => view(`x-${n}`, { status: "failed" })),
    );
    vi.spyOn(k.app.get(CatalogService), "page").mockResolvedValue({
      items: [item({})],
      nextOffset: null,
    });
    const r = await root({ method: "GET", url: "/api/v1/admin/overview" });
    expect(r.statusCode, r.body).toBe(200);
    // 4 inbox + 23 extensions + 1 update + 2 providers (model-eval, model-embed-probe)
    expect(r.json()).toEqual({ orgs: 0, accounts: 1, attentionTotal: 30, partial: false });
  });

  it("counts a plugin waiting for its permission confirmation once, as the inbox item", async () => {
    // the platform item waits in the inbox (permission_confirmation) and its extension is
    // pending_approval: listed and counted only in the inbox; a config-declared extension with no
    // catalog item stays in attention
    vi.spyOn(k.app.get(ExtensionAdmin), "list").mockResolvedValue([
      view("crm", { status: "pending_approval" }),
      view("declared", { status: "pending_approval" }),
    ]);
    vi.spyOn(k.app.get(CatalogService), "page").mockResolvedValue({
      items: [item({ name: "crm", pending: true, newerInMarketplace: false })],
      nextOffset: null,
    });
    const a = await attention();
    expect(a.extensions.map((e) => e.name)).toEqual(["declared"]);
    const inbox = await root({ method: "GET", url: "/api/v1/admin/inbox" });
    expect(inbox.json().byType.permission_confirmation).toBe(1);
    const r = await root({ method: "GET", url: "/api/v1/admin/overview" });
    // 1 inbox item + 1 extension (declared) + 2 providers
    expect(r.json()).toMatchObject({ attentionTotal: 4, partial: false });
  });

  it("is partial when an attention source could not be read", async () => {
    vi.spyOn(k.app.get(ProviderRegistry), "listWithStatus").mockRejectedValue(new Error("down"));
    const r = await root({ method: "GET", url: "/api/v1/admin/overview" });
    expect(r.statusCode, r.body).toBe(200);
    // badconfig only: the providers are not counted, and the answer says so
    expect(r.json()).toEqual({ orgs: 0, accounts: 1, attentionTotal: 1, partial: true });
  });
});
