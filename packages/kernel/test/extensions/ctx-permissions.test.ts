import { fileURLToPath } from "node:url";
import {
  defineExtension,
  type ExtensionManifest,
  ExtensionPermissionError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import { createExtensionContext, type KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { currentScope } from "../../src/infra/database/org-scope.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    locks: new LockService(redis, createLogger("error")),
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    embedTokens: new EmbedTokens(createKeyring(Buffer.alloc(32, 1), [])),
    hooks: undefined,
    shares: undefined,
    runWorkers: false,
    log: quiet,
  };
});
afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await deps?.db.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.audit_events`.execute(deps.db);
  await redis.flushdb();
});

const mf = (over: Partial<ExtensionManifest> = {}) =>
  defineExtension({
    name: "perm-test",
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    setup() {},
    ...over,
  });

const denials = async () =>
  kernelDb(deps.db)
    .selectFrom("audit_events")
    .select(["action", "target", "detail"])
    .where("action", "=", "extension.permission_denied")
    .execute();

const spec = (name: string): ToolSpec => ({ name, description: "Probe.", inputSchema: {} });
const handler = async () => ({ content: [] });

describe("ctx.models (permissions.models)", () => {
  it("without permissions.models (or with an empty list) ctx.models throws and audits", async () => {
    for (const permissions of [{}, { models: [] }]) {
      const ctx = createExtensionContext(deps, mf({ permissions }), {});
      expect(() => ctx.models).toThrow(ExtensionPermissionError);
      expect(Object.keys(ctx)).not.toContain("models");
      await ctx.close();
    }
    expect((await denials())[0]?.detail).toMatchObject({ item: "permissions.models" });
  });

  it("calls the broker with a frozen copy of the declared purposes and the instance signal", async () => {
    const seen: { plugin: string; declared: unknown; signal: AbortSignal }[] = [];
    const models = {
      embeddings: {
        embed: async (plugin: string, declared: unknown, _req: unknown, signal: AbortSignal) => {
          seen.push({ plugin, declared, signal });
          return { vectors: [], model: { provider: "p", id: "m" }, dimensions: 8 };
        },
        describe: async () => null,
      },
      images: {
        generateForExtension: async () => {
          throw new Error("not called");
        },
        describeForExtension: async () => null,
      },
    };
    const declared = [
      { purpose: "perm-test.memory", kind: "embedding" as const, label: { zh: "记", en: "M" } },
    ];
    const manifest = mf({ permissions: { models: declared } });
    const ctx = createExtensionContext({ ...deps, models }, manifest, {});
    // the extension changes its manifest object after approval: the ctx keeps the approved copy
    declared.push({ purpose: "other.x", kind: "embedding", label: { zh: "x", en: "x" } });
    await ctx.models.embed({ orgId: "o", purpose: "perm-test.memory", input: [] });
    expect(seen[0]?.plugin).toBe("perm-test");
    expect(seen[0]?.declared).toEqual([declared[0]]);
    expect(Object.isFrozen(seen[0]?.declared)).toBe(true);
    expect(seen[0]?.signal).toBe(ctx.signal);
    await ctx.close();
  });

  it("generateImage goes to the image broker; describe dispatches on the declared kind", async () => {
    const calls: string[] = [];
    let imageSignal: AbortSignal | undefined;
    const models = {
      embeddings: {
        embed: async () => {
          throw new Error("not called");
        },
        describe: async (_plugin: string, _declared: unknown, req: { purpose: string }) => {
          calls.push(`embeddings.describe ${req.purpose}`);
          return null;
        },
      },
      images: {
        generateForExtension: async (
          plugin: string,
          _declared: unknown,
          req: { purpose: string },
          signal: AbortSignal,
        ) => {
          calls.push(`images.generate ${plugin} ${req.purpose}`);
          imageSignal = signal;
          return {
            images: [],
            model: { provider: "p", id: "i" },
            size: { width: 1, height: 1 },
          };
        },
        describeForExtension: async (
          _plugin: string,
          _declared: unknown,
          req: { purpose: string },
        ) => {
          calls.push(`images.describe ${req.purpose}`);
          return null;
        },
      },
    };
    const manifest = mf({
      permissions: {
        models: [
          { purpose: "perm-test.memory", kind: "embedding", label: { zh: "记", en: "M" } },
          { purpose: "perm-test.art", kind: "image_generation", label: { zh: "图", en: "A" } },
        ],
      },
    });
    const ctx = createExtensionContext({ ...deps, models }, manifest, {});
    await ctx.models.generateImage({ orgId: "o", purpose: "perm-test.art", prompt: "x" });
    await ctx.models.describe({ orgId: "o", purpose: "perm-test.art" });
    await ctx.models.describe({ orgId: "o", purpose: "perm-test.memory" });
    // an undeclared purpose reaches no broker: refused with a text that names no kind
    await expect(
      ctx.models.describe({ orgId: "o", purpose: "perm-test.other" }),
    ).rejects.toMatchObject({
      code: "model.purpose_unknown",
      message:
        'Extension perm-test declared no model purpose "perm-test.other" in permissions.models',
    });
    expect(calls).toEqual([
      "images.generate perm-test perm-test.art",
      "images.describe perm-test.art",
      "embeddings.describe perm-test.memory",
    ]);
    expect(imageSignal).toBe(ctx.signal);
    await ctx.close();
  });

  it("without a broker (a ctx built alone) ctx.models calls reject", async () => {
    const ctx = createExtensionContext(
      deps,
      mf({
        permissions: {
          models: [{ purpose: "perm-test.m", kind: "embedding", label: { zh: "m", en: "m" } }],
        },
      }),
      {},
    );
    await expect(ctx.models.describe({ orgId: "o", purpose: "perm-test.m" })).rejects.toThrow(
      /not available/,
    );
    await ctx.close();
  });
});

describe("ctx.triggers (permissions.triggers)", () => {
  const event = {
    orgId: "o1",
    type: "item.created",
    subject: { kind: "item", id: "1", title: "One" },
    facts: {},
    summary: "Item one was created.",
    dedupeKey: "k",
  };

  it("without permissions.triggers ctx.triggers throws and audits", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ctx.triggers).toThrow(ExtensionPermissionError);
    expect(Object.keys(ctx)).not.toContain("triggers");
    await ctx.close();
    expect((await denials())[0]?.detail).toMatchObject({ item: "permissions.triggers" });
  });

  it("emits through the backend as this extension, with a frozen copy of the declared types, in the event's org scope", async () => {
    const seen: { plugin: string; declared: readonly string[]; scope: unknown }[] = [];
    const triggers = () => ({
      emit: async (plugin: string, declared: readonly string[]) => {
        seen.push({ plugin, declared, scope: currentScope() });
        return { eventId: "e1", duplicate: false };
      },
      causeOf: async () => "h1",
    });
    const emit = ["item.created"];
    const ctx = createExtensionContext(
      { ...deps, triggers },
      mf({ permissions: { triggers: { emit } } }),
      {},
    );
    // the extension changes its manifest object after approval: the ctx keeps the approved copy
    emit.push("item.secret");
    expect(await ctx.triggers.emit(event)).toEqual({ eventId: "e1", duplicate: false });
    expect(seen).toEqual([
      { plugin: "perm-test", declared: ["item.created"], scope: { kind: "org", orgId: "o1" } },
    ]);
    expect(Object.isFrozen(seen[0]?.declared)).toBe(true);
    await expect(ctx.triggers.emit({ ...event, orgId: "" })).rejects.toMatchObject({
      code: "invalid_event",
    });
    await ctx.close();
  });

  it("the backend gets one plain snapshot: getters read once, cause.call kept by reference", async () => {
    const got: unknown[] = [];
    const triggers = () => ({
      emit: async (_plugin: string, _declared: readonly string[], e: unknown) => {
        got.push(e);
        return { eventId: "e1", duplicate: false };
      },
      causeOf: async () => "h1",
    });
    const ctx = createExtensionContext(
      { ...deps, triggers },
      mf({ permissions: { triggers: { emit: ["item.created"] } } }),
      {},
    );
    let reads = 0;
    const call = { orgId: "o1", signal: new AbortController().signal } as never;
    const e = { ...event, cause: { call } };
    Object.defineProperty(e, "type", {
      enumerable: true,
      get: () => (reads++ === 0 ? "item.created" : "item.secret"),
    });
    await ctx.triggers.emit(e);
    expect(reads).toBe(1);
    const snap = got[0] as typeof e;
    expect(snap).not.toBe(e);
    expect(Object.getOwnPropertyDescriptor(snap, "type")?.value).toBe("item.created");
    expect(snap.cause.call).toBe(call);
    // data that cannot be cloned is refused, never passed on
    await expect(
      ctx.triggers.emit({ ...event, facts: { f: (() => 1) as never } }),
    ).rejects.toMatchObject({ code: "invalid_event" });
    expect(got).toHaveLength(1);
    await ctx.close();
  });

  it("causeOf asks the backend as this extension, in the call's org scope", async () => {
    const seen: { plugin: string; orgId: string; call: unknown; scope: unknown }[] = [];
    const triggers = () => ({
      emit: async () => ({ eventId: "e1", duplicate: false }),
      causeOf: async (plugin: string, orgId: string, call: unknown) => {
        seen.push({ plugin, orgId, call, scope: currentScope() });
        return "h1";
      },
    });
    const ctx = createExtensionContext(
      { ...deps, triggers },
      mf({ permissions: { triggers: { emit: ["item.created"] } } }),
      {},
    );
    const call = { orgId: "o1" } as never;
    expect(await ctx.triggers.causeOf(call)).toBe("h1");
    expect(seen).toEqual([
      { plugin: "perm-test", orgId: "o1", call, scope: { kind: "org", orgId: "o1" } },
    ]);
    // the call is passed by reference: the pipeline's call scope is a symbol-keyed field
    expect(seen[0]?.call).toBe(call);
    for (const bad of [{ orgId: "" }, null, "o1"])
      await expect(ctx.triggers.causeOf(bad as never)).rejects.toMatchObject({
        code: "invalid_event",
      });
    expect(seen).toHaveLength(1);
    await ctx.close();
  });

  it("without a backend (a ctx built alone, the CLI) emit rejects", async () => {
    const ctx = createExtensionContext(
      deps,
      mf({ permissions: { triggers: { emit: ["item.created"] } } }),
      {},
    );
    await expect(ctx.triggers.emit(event)).rejects.toThrow("not available");
    await ctx.close();
  });
});

describe("ctx.inbox (permissions.inbox)", () => {
  const item = { orgId: "o1", accountId: "a1", kind: "item.assigned", title: "Assigned" };

  it("without permissions.inbox ctx.inbox throws ExtensionPermissionError and audits", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ctx.inbox).toThrow(ExtensionPermissionError);
    expect(Object.keys(ctx)).not.toContain("inbox");
    await ctx.close();
    expect((await denials())[0]?.detail).toMatchObject({ item: "permissions.inbox" });
  });

  it("posts and resolves as this extension, from a plain copy, in the item's org scope", async () => {
    const seen: { op: string; source?: unknown; args: unknown; scope: unknown }[] = [];
    const inbox = () => ({
      post: async (source: unknown, p: unknown) => {
        seen.push({ op: "post", source, args: p, scope: currentScope() });
        return { itemId: "i1" };
      },
      resolveForPlugin: async (plugin: string, orgId: string, itemId: string) => {
        seen.push({ op: "resolve", args: { plugin, orgId, itemId }, scope: currentScope() });
      },
    });
    const ctx = createExtensionContext(
      { ...deps, inbox } as never,
      mf({ permissions: { inbox: true } }),
      {},
    );
    expect(await ctx.inbox.post(item)).toEqual({ itemId: "i1" });
    await ctx.inbox.resolve({ orgId: "o1", itemId: "i1" });
    expect(seen).toEqual([
      {
        op: "post",
        source: { kind: "plugin", plugin: "perm-test" },
        args: item,
        scope: { kind: "org", orgId: "o1" },
      },
      {
        op: "resolve",
        args: { plugin: "perm-test", orgId: "o1", itemId: "i1" },
        scope: { kind: "org", orgId: "o1" },
      },
    ]);
    expect(seen[0]?.args).not.toBe(item);
    await expect(ctx.inbox.post({ ...item, orgId: "" })).rejects.toMatchObject({
      code: "invalid_item",
    });
    await ctx.close();
  });

  it("without a backend (a ctx built alone, the CLI) post rejects", async () => {
    const ctx = createExtensionContext(deps, mf({ permissions: { inbox: true } }), {});
    await expect(ctx.inbox.post(item)).rejects.toThrow("not available");
    await ctx.close();
  });
});

describe("ctx 按权限清单构造", () => {
  it("未声明 secrets：访问抛 ExtensionPermissionError 并写审计（每个插件每项只记一次）", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ctx.secrets).toThrow(ExtensionPermissionError);
    expect(() => ctx.secrets.get("o", "k")).toThrow(/permissions\.secrets/);
    await ctx.close();
    const rows = await denials();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("perm-test");
    expect(rows[0]?.detail).toMatchObject({ item: "permissions.secrets" });
    // 另一个 ctx（如另一副本）再次越权同一项：仍只记一次
    const again = createExtensionContext(deps, mf(), {});
    expect(() => again.secrets).toThrow(ExtensionPermissionError);
    await again.close();
    expect(await denials()).toHaveLength(1);
    // 去重键带 TTL
    const keys = await redis.keys("capk:*");
    expect(keys).toHaveLength(1);
    expect(await redis.ttl(keys[0] as string)).toBeGreaterThan(0);
  });

  it("未声明 secrets：展开 / 列举 / 打印 ctx 不触发越权（getter 不可枚举）", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ({ ...ctx })).not.toThrow();
    expect(Object.keys(ctx)).not.toContain("secrets");
    expect(() => JSON.stringify(Object.fromEntries(Object.entries(ctx)))).not.toThrow();
    expect("secrets" in ctx).toBe(true);
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("声明了 secrets：可用，且是普通可枚举属性", async () => {
    const ctx = createExtensionContext(deps, mf({ permissions: { secrets: true } }), {});
    expect(typeof ctx.secrets.get).toBe("function");
    expect(Object.keys(ctx)).toContain("secrets");
    expect(typeof { ...ctx }.secrets.get).toBe("function");
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("未声明 storage：访问抛 ExtensionPermissionError 并写审计；getter 不可枚举", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ctx.storage).toThrow(ExtensionPermissionError);
    expect(() => ctx.storage.head("o", "k")).toThrow(/permissions\.storage/);
    expect(Object.keys(ctx)).not.toContain("storage");
    expect(() => ({ ...ctx })).not.toThrow();
    await ctx.close();
    const rows = await denials();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ item: "permissions.storage" });
  });

  it("声明了 storage：可取到 ctx.storage；没有对象存储提供方时每个方法 reject storage.unavailable", async () => {
    const ctx = createExtensionContext(deps, mf({ permissions: { storage: true } }), {});
    expect(Object.keys(ctx)).toContain("storage");
    const s = ctx.storage;
    const calls = [
      s.put("o", "k", new Uint8Array(1), { contentType: "text/plain" }),
      s.get("o", "k"),
      s.head("o", "k"),
      s.delete("o", "k"),
      s.deletePrefix("o", ""),
      s.list("o", ""),
      s.presignGet("o", "k", { ttlSeconds: 60 }),
      s.presignPut("o", "k", { contentType: "text/plain", maxSize: 1, ttlSeconds: 60 }),
    ];
    for (const c of calls) await expect(c).rejects.toThrow(/storage\.unavailable/);
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("http.route: only a declared method + path; the record carries access and its mount", async () => {
    const ctx = createExtensionContext(
      deps,
      mf({
        permissions: {
          http: [
            { method: "GET", path: "/items", access: "member" },
            { method: "PUT", path: "/settings", access: "admin" },
            { method: "POST", path: "/hook", access: "public" },
            { method: "GET", path: "/ui/data", access: "embed" },
          ],
        },
      }),
      {},
    );
    const h = async () => new Response("ok");
    ctx.http.route("GET", "/items", h);
    ctx.http.route("PUT", "/settings", h);
    ctx.http.route("POST", "/hook", h);
    ctx.http.route("GET", "/ui/data", h);
    // declared only as GET: POST is refused; undeclared paths too
    expect(() => ctx.http.route("POST", "/items", h)).toThrow(ExtensionPermissionError);
    expect(() => ctx.http.route("GET", "/b", h)).toThrow(/permissions\.http.*GET \/b/);
    expect(() => ctx.http.route("GET", "/items", h)).toThrow(/duplicate route GET \/items/);
    expect(ctx.routes.map((r) => [r.plugin, r.method, r.path, r.access])).toEqual([
      ["perm-test", "GET", "/plugins/perm-test/orgs/:orgId/items", "member"],
      ["perm-test", "PUT", "/plugins/perm-test/orgs/:orgId/settings", "admin"],
      ["perm-test", "POST", "/plugins/perm-test/hook", "public"],
      ["perm-test", "GET", "/plugins/perm-test/ui/data", "embed"],
    ]);
    // the record's embed verifier is the extension's own ctx.ui.verifyEmbedToken
    for (const r of ctx.routes) {
      expect(r.verifyEmbed).toBe(ctx.ui.verifyEmbedToken);
      expect(r.handler).toBe(h);
    }
    expect(await ctx.routes[3]?.verifyEmbed("not-a-token")).toBeNull();
    await ctx.close();
    expect(ctx.routes).toEqual([]);
    const items = (await denials()).map((r) => (r.detail as { item: string }).item).sort();
    expect(items).toEqual(["permissions.http GET /b", "permissions.http POST /items"]);
  });

  it("没有 permissions.http：任何路由都被拒绝", async () => {
    const ctx = createExtensionContext(deps, mf(), {});
    expect(() => ctx.http.route("GET", "/a", async () => new Response())).toThrow(
      ExtensionPermissionError,
    );
    await ctx.close();
  });

  it("tools.register：只允许清单中声明的工具名", async () => {
    const ctx = createExtensionContext(deps, mf({ permissions: { tools: ["echo"] } }), {});
    ctx.tools.register(spec("echo"), handler);
    expect(() => ctx.tools.register(spec("other"), handler)).toThrow(ExtensionPermissionError);
    expect(() => ctx.tools.register(spec("other"), handler)).toThrow(/permissions\.tools.*other/);
    expect(ctx.registeredTools.map((t) => t.spec.name)).toEqual(["echo"]);
    await ctx.close();
    expect(await denials()).toHaveLength(1);
  });

  it("自动授予的基础能力无需声明", async () => {
    const ctx = createExtensionContext(deps, mf({ provides: ["counter@1"] }), { a: 1 });
    expect(ctx.kv).toBeDefined();
    expect(ctx.lock).toBeDefined();
    expect(ctx.bus).toBeDefined();
    expect(ctx.queue).toBeDefined();
    expect(ctx.log).toBeDefined();
    expect(ctx.db).toBeDefined();
    expect(ctx.config).toEqual({ a: 1 });
    ctx.provide("counter@1", {});
    await ctx.close();
    expect(await denials()).toEqual([]);
  });

  it("审计写入失败只记 warn，不影响抛出的 ExtensionPermissionError", async () => {
    const warn = vi.fn();
    const broken = {
      ...deps,
      log: { ...quiet, warn },
      db: createDb("postgres://x@127.0.0.1:1/x", 1),
    };
    const ctx = createExtensionContext(broken, mf({ name: "perm-broken" }), {});
    expect(() => ctx.secrets).toThrow(ExtensionPermissionError);
    await ctx.close();
    await broken.db.destroy();
    expect(warn).toHaveBeenCalledWith(
      "plugin permission denial audit failed",
      expect.objectContaining({ plugin: "perm-broken" }),
    );
    // 写审计失败时去重键被撤销，下次仍会尝试记录
    expect(await redis.keys("capk:*")).toEqual([]);
  });

  describe("ctx.dialIn", () => {
    const dialInManifest = (over: Partial<ExtensionManifest> = {}) =>
      mf({
        name: "perm-dial-in",
        provides: ["device-provider@1"],
        permissions: { dialIn: { protocol: "perm-dial-in/1" } },
        ...over,
      });
    /** A dial-in relay double: `own` is the only device the extension serves. */
    const access = (own: string) => {
      const calls: { method: string; deviceId: string; opts?: unknown }[] = [];
      return {
        calls,
        api: {
          serves: async (plugin: string, deviceId: string) =>
            plugin === "perm-dial-in" && deviceId === own,
          request: async (deviceId: string, body: unknown, opts: unknown) => {
            calls.push({ method: "request", deviceId, opts });
            return { echoed: body };
          },
          online: async (deviceId: string) => {
            calls.push({ method: "online", deviceId });
            return true;
          },
          capacity: async (deviceId: string) => {
            calls.push({ method: "capacity", deviceId });
            return { maxFrameBytes: 4096 };
          },
          stop: async (deviceId: string) => {
            calls.push({ method: "stop", deviceId });
          },
          openStream: async (deviceId: string, _body: unknown, signal: AbortSignal) => {
            calls.push({ method: "openStream", deviceId, opts: { signal } });
            let resolveClosed!: (v: { reason: string }) => void;
            const closed = new Promise<{ reason: string }>((r) => {
              resolveClosed = r;
            });
            return {
              send: async () => {},
              messages: (async function* () {})(),
              close: (reason?: string) => resolveClosed({ reason: reason ?? "closed" }),
              closed,
            };
          },
        },
      };
    };

    it("ctx.dialIn without permissions.dialIn throws ExtensionPermissionError", async () => {
      const ctx = createExtensionContext(
        { ...deps, dialIn: access("d-1").api },
        mf({ provides: ["device-provider@1"] }),
        {},
      );
      expect(() => ctx.dialIn).toThrow(ExtensionPermissionError);
      expect(Object.keys(ctx)).not.toContain("dialIn");
      await ctx.close();
      expect((await denials())[0]?.detail).toMatchObject({ item: "permissions.dialIn" });
    });

    /** A device reports double: `own` is the only device bound to `perm-dial-in`. */
    const reports = (own: string) => {
      const calls: { plugin: string; deviceId: string; signal?: AbortSignal }[] = [];
      return {
        calls,
        api: {
          changed: async (plugin: string, deviceId: string, signal?: AbortSignal) => {
            calls.push({ plugin, deviceId, ...(signal && { signal }) });
            return plugin === "perm-dial-in" && deviceId === own ? "bumped" : "not-served";
          },
        } as NonNullable<KernelDeps["devices"]>,
      };
    };

    it("ctx.devices for an extension that provides no device provider throws ExtensionPermissionError", async () => {
      const ctx = createExtensionContext({ ...deps, devices: reports("d-1").api }, mf(), {});
      expect(() => ctx.devices).toThrow(ExtensionPermissionError);
      expect(Object.keys(ctx)).not.toContain("devices");
      await ctx.close();
      expect((await denials())[0]?.detail).toMatchObject({
        item: "provides device-provider@1",
      });
    });

    it("ctx.devices.reportChanged reads its own device's report again, under the instance's signal", async () => {
      const r = reports("d-1");
      const ctx = createExtensionContext({ ...deps, devices: r.api }, dialInManifest(), {});
      await ctx.devices.reportChanged("d-1");
      expect(r.calls.map((c) => [c.plugin, c.deviceId])).toEqual([["perm-dial-in", "d-1"]]);
      expect(r.calls[0]?.signal?.aborted).toBe(false);
      await ctx.close();
      expect(r.calls[0]?.signal?.aborted).toBe(true);
      expect(await denials()).toEqual([]);
    });

    it("ctx.devices.reportChanged for a device of another provider throws ExtensionPermissionError and audits", async () => {
      const ctx = createExtensionContext(
        { ...deps, devices: reports("d-1").api },
        dialInManifest(),
        {},
      );
      for (const id of ["d-other", 42 as unknown as string]) {
        const e = await ctx.devices.reportChanged(id).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(ExtensionPermissionError);
        expect((e as Error).message).toBe(`device ${id} is not served by perm-dial-in`);
      }
      await ctx.close();
      expect((await denials()).map((d) => d.detail)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item: "devices:device d-other" }),
          expect.objectContaining({ item: "devices:device 42" }),
        ]),
      );
    });

    it("ctx.dialIn for a device of another provider throws ExtensionPermissionError and audits", async () => {
      const a = access("d-1");
      const ctx = createExtensionContext({ ...deps, dialIn: a.api }, dialInManifest(), {});
      for (const call of [
        () => ctx.dialIn.request("d-other", { x: 1 }, { timeoutMs: 1000 }),
        () => ctx.dialIn.online("d-other"),
        () => ctx.dialIn.capacity("d-other"),
        () => ctx.dialIn.stop("d-other", "stop"),
        () => ctx.dialIn.openStream("d-other", {}, { signal: new AbortController().signal }),
      ]) {
        const e = await call().then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(ExtensionPermissionError);
        expect((e as Error).message).toBe("device d-other is not served by perm-dial-in");
      }
      expect(a.calls).toEqual([]);
      await ctx.close();
      expect((await denials())[0]?.detail).toMatchObject({ item: "dialIn:device d-other" });
    });

    it("ctx.dialIn for its own device relays with only the options an extension may pass", async () => {
      const a = access("d-1");
      const ctx = createExtensionContext({ ...deps, dialIn: a.api }, dialInManifest(), {});
      const own = new AbortController();
      expect(
        await ctx.dialIn.request("d-1", { x: 1 }, {
          timeoutMs: 1000,
          signal: own.signal,
          // a kernel fence smuggled in by the extension never reaches the relay
          connection: { connectionId: "c", maxFrameBytes: 1 },
        } as never),
      ).toEqual({ echoed: { x: 1 } });
      expect(await ctx.dialIn.online("d-1")).toBe(true);
      expect(await ctx.dialIn.capacity("d-1")).toEqual({ maxFrameBytes: 4096 });
      await ctx.dialIn.stop("d-1", "drain");
      // the signal is required: an open nobody can abort is refused before the access is asked
      await expect(ctx.dialIn.openStream("d-1", { t: 1 }, {} as never)).rejects.toThrow(TypeError);
      const stream = await ctx.dialIn.openStream("d-1", { t: 1 }, { signal: own.signal });
      expect(a.calls.map((c) => c.method)).toEqual([
        "request",
        "online",
        "capacity",
        "stop",
        "openStream",
      ]);
      const opts = a.calls[0]?.opts as { timeoutMs: number; signal: AbortSignal };
      expect(Object.keys(opts).sort()).toEqual(["signal", "timeoutMs"]);
      // the instance's signal joins the extension's: an unload aborts the wait
      expect(opts.signal.aborted).toBe(false);
      await ctx.close();
      expect(opts.signal.aborted).toBe(true);
      // the extension's end closes its open streams
      expect(await stream.closed).toEqual({ reason: "extension stopped" });
      expect(await denials()).toEqual([]);
    });
  });
});
