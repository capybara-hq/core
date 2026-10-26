import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountsService,
  createDb,
  createKernel,
  createLogger,
  type Kernel,
  KernelConfigSchema,
  kernelDb,
  readExtensionPackage,
  readPluginPackage,
} from "@capybara-hq/kernel";
import {
  type BootstrapEntry,
  bootstrapFileName,
  type Connector,
  type ConnectorSession,
  type ModelProvider,
  type ObjectStore,
  SDK_VERSION,
  type ToolCallContext,
} from "@capybara-hq/plugin-sdk";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeConnector,
  FAKE_ROUTE_META,
} from "../fixtures/extensions/fake-connector/src/index.js";
import {
  FAKE_EXTENSIONS,
  type FakeExtensionName,
  FakeMcpRpcError,
  type FakeMcpTool,
  fakeExtensionEntry,
  packFixture,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "../src/index.js";

/**
 * The fake extensions of `fixtures/extensions` (see src/fixtures.ts): each packs with the plugin
 * packer and passes the kernel's package readers, and each loads in a kernel and provides its
 * extension point. The kernel-side contracts are asserted where the fakes replace official plugins.
 */

const MAX_BYTES = 64 * 1024 * 1024;

/** What each fake's extension provides / requires (all fakes have an extension). */
const EXPECTED: Record<FakeExtensionName, { provides: string[]; requires?: string[] }> = {
  "fake-connector": { provides: ["connector@1"] },
  "fake-object-store": { provides: ["object-store@1"] },
  "fake-tools-ui": { provides: [] },
  "fake-storage-user": { provides: [] },
  "fake-embed": { provides: [] },
  "fake-bootstrap-a": { provides: ["model-provider@2"] },
  "fake-bootstrap-b": { provides: ["object-store@1"] },
  "fake-dep-provider": { provides: ["counter@1"] },
  "fake-dep-requirer": { provides: [], requires: ["counter@1"] },
};

let out: string;
const packed = new Map<FakeExtensionName, Uint8Array>();

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "testing-fixtures-"));
  for (const name of FAKE_EXTENSIONS) packed.set(name, (await packFixture(name, out)).bytes);
}, 120_000);

afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

describe("packing", () => {
  it.each(FAKE_EXTENSIONS)(
    "%s packs and passes readPluginPackage / readExtensionPackage",
    async (name) => {
      const bytes = packed.get(name) as Uint8Array;
      const plugin = await readPluginPackage(bytes, {
        maxBytes: MAX_BYTES,
        hostSdkVersion: SDK_VERSION,
      });
      expect(plugin.manifest).toMatchObject({ name, version: "0.1.0" });
      const ext = plugin.manifest.extension;
      expect(ext?.entry).toBe("./dist/index.mjs");
      expect(ext?.manifest.provides).toEqual(EXPECTED[name].provides);
      expect(ext?.manifest.requires ?? []).toEqual(EXPECTED[name].requires ?? []);
      const pkg = await readExtensionPackage(bytes, {
        maxBytes: MAX_BYTES,
        hostSdkVersion: SDK_VERSION,
      });
      expect(pkg.section.manifest.name).toBe(name);
    },
  );

  it.each(FAKE_EXTENSIONS)("%s packs reproducibly", async (name) => {
    const again = await mkdtemp(join(tmpdir(), "testing-fixtures-again-"));
    try {
      const r = await packFixture(name, again);
      expect(Buffer.from(r.bytes).equals(Buffer.from(packed.get(name) as Uint8Array))).toBe(true);
      expect(r.sha256).toBe(createHash("sha256").update(r.bytes).digest("hex"));
    } finally {
      await rm(again, { recursive: true, force: true });
    }
  });

  it("fake-tools-ui carries its migration, skill and connector template", async () => {
    const plugin = await readPluginPackage(packed.get("fake-tools-ui") as Uint8Array, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    expect(plugin.manifest.extension?.migrations).toBe("./migrations");
    expect(plugin.files.has("migrations/0001_init.sql")).toBe(true);
    expect(plugin.skills.map((s) => s.name)).toEqual(["fake-notes"]);
    expect(
      plugin.connectorTemplates.map((t) => [
        t.id,
        t.file.template.plugin,
        t.file.template.connector,
      ]),
    ).toEqual([["fake-notes", "fake-connector", "fake"]]);
    // Like todo: no storage permission, so it runs without an object store
    expect(plugin.manifest.extension?.manifest.permissions).toEqual({
      tools: ["write"],
      ui: { views: ["tasks"] },
    });
    const storageUser = await readPluginPackage(packed.get("fake-storage-user") as Uint8Array, {
      maxBytes: MAX_BYTES,
      hostSdkVersion: SDK_VERSION,
    });
    expect(storageUser.manifest.extension?.manifest.permissions).toEqual({
      tools: ["note", "read_note"],
      storage: true,
    });
  });

  it("fake-connector ships its template; fake-dep-requirer depends on fake-dep-provider", async () => {
    const opts = { maxBytes: MAX_BYTES, hostSdkVersion: SDK_VERSION };
    const conn = await readPluginPackage(packed.get("fake-connector") as Uint8Array, opts);
    expect(conn.connectorTemplates.map((t) => t.id)).toEqual(["fake-demo"]);
    const req = await readPluginPackage(packed.get("fake-dep-requirer") as Uint8Array, opts);
    expect(req.manifest.dependencies).toEqual([{ name: "fake-dep-provider", version: "^0.1.0" }]);
  });
});

const silent = () => createLogger("error", { write: () => {} });

const baseConfig = (pgUrl: string, redisUrl: string, over: Record<string, unknown>) =>
  KernelConfigSchema.parse({
    db: { url: pgUrl, poolMax: 5 },
    redis: { url: redisUrl },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    extensionPermissions: { autoApprove: true },
    marketplaces: { official: { enabled: false } },
    log: { level: "error" },
    ...over,
  });

const PW = "correct horse battery";

type Req = (o: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: unknown;
}) => Promise<{ statusCode: number; body: string; json(): unknown }>;

/** Logs in through the kernel HTTP API; the returned request function carries the session cookie. */
async function login(k: Kernel, name: string): Promise<Req> {
  const res = await k.http.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-capybara-csrf": "1" },
    payload: { login: name, password: PW },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""])
    .map((c) => String(c).split(";")[0])
    .join("; ");
  return (o) =>
    k.http.inject({
      method: o.method,
      url: o.url,
      headers: { cookie, "x-capybara-csrf": "1" },
      ...(o.payload !== undefined && { payload: o.payload as Record<string, unknown> }),
    });
}

const toolCtx = (orgId: string, conversationId: string): ToolCallContext => ({
  orgId,
  accountId: randomUUID(),
  agentId: randomUUID(),
  conversationId,
  callId: randomUUID(),
  signal: new AbortController().signal,
});

describe("loaded by path in a kernel", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let s3: TestS3;
  let k: Kernel;
  let dir: string;
  let destroyDb: (() => Promise<void>) | undefined;
  let root: Req;
  let orgId: string;

  beforeAll(async () => {
    [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
    dir = await mkdtemp(join(tmpdir(), "testing-fixtures-ext-"));
    const config = baseConfig(pgc.url, rd.url, {
      roles: ["api", "worker"],
      extensionHost: { dir },
      extensions: [
        fakeExtensionEntry("fake-connector"),
        fakeExtensionEntry("fake-object-store"),
        fakeExtensionEntry("fake-tools-ui"),
        fakeExtensionEntry("fake-storage-user"),
        fakeExtensionEntry("fake-embed"),
        fakeExtensionEntry("fake-dep-provider"),
        fakeExtensionEntry("fake-dep-requirer"),
      ],
      extensionConfig: {
        "fake-object-store": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
      },
    });
    k = await createKernel(config, { env: {}, logger: silent() });
    await k.start();
    const raw = createDb(pgc.url, 2);
    destroyDb = () => raw.destroy();
    await new AccountsService(kernelDb(raw)).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      enterpriseAdmin: true,
    });
    root = await login(k, "root");
    const org = await root({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
    expect(org.statusCode, org.body).toBe(201);
    orgId = (org.json() as { org: { id: string } }).org.id;
  }, 300_000);

  afterAll(async () => {
    await k?.stop();
    await destroyDb?.();
    if (dir) await rm(dir, { recursive: true, force: true });
    await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  });

  const provider = <T>(point: string, plugin: string): T => {
    const e = k.host.list(point).find((x) => x.plugin === plugin);
    expect(e, `${plugin} provides ${point}`).toBeDefined();
    return e?.impl as T;
  };

  describe("fake-connector", () => {
    const connector = () => provider<Connector>("connector", "fake-connector");
    const openArgs = (o: Partial<Parameters<Connector["open"]>[0]> = {}) => ({
      endpoint: o.endpoint,
      auth: o.auth ?? (async () => ({ headers: {} })),
      onUnauthorized: o.onUnauthorized ?? (async () => {}),
      signal: new AbortController().signal,
      ...(o.onToolsChanged !== undefined && { onToolsChanged: o.onToolsChanged }),
      ...(o.onElicit !== undefined && { onElicit: o.onElicit }),
    });

    it("validates the endpoint: loopback http and https, no credential headers", () => {
      const c = connector();
      expect(c.kind).toBe("fake");
      expect(c.endpointSchema.safeParse({ url: "http://127.0.0.1:1/mcp" }).success).toBe(true);
      expect(c.endpointSchema.safeParse({ url: "https://mcp.example.com/mcp" }).success).toBe(true);
      expect(c.endpointSchema.safeParse({ url: "http://mcp.example.com/mcp" }).success).toBe(false);
      expect(
        c.endpointSchema.safeParse({
          url: "https://x.example.com",
          headers: { Authorization: "x" },
        }).success,
      ).toBe(false);
    });

    it("injects auth before each request, refreshes once on 401, routes calls by connectorData", async () => {
      let token = "old";
      let refreshed = 0;
      const mcp = await startFakeMcpServer({
        tools: [
          {
            name: "search",
            description: "Search things",
            annotations: { readOnlyHint: true },
            handler: (info) => ({
              content: [{ type: "text", text: `found ${String(info.args.q)}` }],
            }),
          },
        ],
        requireBearer: "new",
      });
      try {
        const s: ConnectorSession = await connector().open(
          openArgs({
            endpoint: { url: mcp.url },
            auth: async () => ({ headers: { Authorization: `Bearer ${token}` } }),
            onUnauthorized: async () => {
              refreshed++;
              token = "new";
            },
          }),
        );
        try {
          const tools = await s.listTools();
          expect(tools).toEqual([
            {
              name: "search",
              description: "Search things",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
              connectorData: { tool: "search" },
            },
          ]);
          const r = await s.callTool("renamed", { q: "x" }, new AbortController().signal, {
            spec: tools[0] as (typeof tools)[number],
          });
          expect(r).toEqual({ content: [{ type: "text", text: "found x" }] });
        } finally {
          await s.close();
        }
        expect(refreshed).toBe(1);
        expect(mcp.calls.map((c) => c.headers.authorization)).toEqual(["Bearer new"]);
      } finally {
        await mcp.stop();
      }
    });

    it("a second 401 after the refresh fails with a ToolError", async () => {
      const mcp = await startFakeMcpServer({ tools: [], requireBearer: "never" });
      try {
        await expect(
          connector().open(openArgs({ endpoint: { url: mcp.url } })),
        ).rejects.toMatchObject({ name: "ToolError", kind: "error" });
      } finally {
        await mcp.stop();
      }
    });

    it("reports tools/list_changed and answers elicitations through the kernel callbacks", async () => {
      const mcp = await startFakeMcpServer({
        sessions: true,
        sseResponses: true,
        tools: [
          {
            name: "ask",
            description: "Asks the user",
            handler: async (_info, ctx) => {
              await ctx.notifyToolsChanged();
              const r = await ctx.elicit({
                message: "Pick a color",
                requestedSchema: { type: "object", properties: { color: { type: "string" } } },
              });
              return { content: [{ type: "text", text: JSON.stringify(r) }] };
            },
          },
        ],
      });
      let changed = 0;
      try {
        const s = await connector().open(
          openArgs({
            endpoint: { url: mcp.url },
            onToolsChanged: () => {
              changed++;
            },
            onElicit: async (req) => {
              expect(req).toMatchObject({ mode: "form", message: "Pick a color" });
              return { action: "accept", content: { color: "red" } };
            },
          }),
        );
        try {
          const r = await s.callTool("ask", {}, new AbortController().signal);
          expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({
            action: "accept",
            content: { color: "red" },
          });
        } finally {
          await s.close();
        }
        expect(changed).toBe(1);
      } finally {
        await mcp.stop();
      }
    });

    it("offers resources and prompts when the server declares them", async () => {
      const mcp = await startFakeMcpServer({
        tools: [],
        resources: [{ uri: "mem://a", name: "a", text: "A" }],
        prompts: [{ name: "greet", arguments: [{ name: "who", required: true }] }],
      });
      try {
        const s = await connector().open(openArgs({ endpoint: { url: mcp.url } }));
        try {
          expect(await s.listResources?.()).toEqual([{ uri: "mem://a", name: "a" }]);
          expect(await s.readResource?.("mem://a")).toEqual({
            content: [{ type: "text", text: "A" }],
          });
          expect(await s.listPrompts?.()).toEqual([
            { name: "greet", arguments: [{ name: "who", required: true }] },
          ]);
          expect((await s.getPrompt?.("greet", { who: "x" }))?.messages[0]?.role).toBe("user");
        } finally {
          await s.close();
        }
      } finally {
        await mcp.stop();
      }
    });

    it("inspect: a bearer hint behind 401, the tools as operations otherwise", async () => {
      const locked = await startFakeMcpServer({ tools: [], requireBearer: "t" });
      const open = await startFakeMcpServer({ tools: [{ name: "search", description: "Search" }] });
      try {
        const signal = new AbortController().signal;
        expect(await connector().inspect?.({ endpoint: { url: locked.url }, signal })).toEqual({
          authHints: [{ scheme: "bearer", type: "bearer" }],
        });
        expect(await connector().inspect?.({ endpoint: { url: open.url }, signal })).toEqual({
          authHints: [],
          operations: [{ id: "search", method: "POST", path: "/tools/search", summary: "Search" }],
        });
      } finally {
        await Promise.all([locked.stop(), open.stop()]);
      }
    });

    it("inspect: the deployment config picks the hint behind 401 (api_key)", async () => {
      const locked = await startFakeMcpServer({ tools: [], requireBearer: "t" });
      try {
        const c = createFakeConnector(true, "api_key");
        expect(
          await c.inspect?.({
            endpoint: { url: locked.url },
            signal: new AbortController().signal,
          }),
        ).toEqual({
          authHints: [{ scheme: "apiKey", type: "api_key", in: "header", name: "X-API-Key" }],
        });
      } finally {
        await locked.stop();
      }
    });

    it("a route change without a rename changes connectorData; calls keep the given spec's route", async () => {
      const served = (name: string): FakeMcpTool => ({
        name,
        description: `Serves ${name}`,
        handler: () => ({ content: [{ type: "text", text: `served by ${name}` }] }),
      });
      const search: FakeMcpTool = {
        name: "search",
        description: "Search things",
        _meta: { [FAKE_ROUTE_META]: "search-v1" },
      };
      const tools = [search, served("search-v1"), served("search-v2")];
      const mcp = await startFakeMcpServer({ tools });
      try {
        const s = await connector().open(openArgs({ endpoint: { url: mcp.url } }));
        try {
          const reviewed = (await s.listTools()).find((t) => t.name === "search");
          expect(reviewed?.connectorData).toEqual({ tool: "search-v1" });
          // The server moves the tool to another route; its name and description stay
          search._meta = { [FAKE_ROUTE_META]: "search-v2" };
          const pending = (await s.listTools()).find((t) => t.name === "search");
          expect(pending).toEqual({ ...reviewed, connectorData: { tool: "search-v2" } });
          const signal = new AbortController().signal;
          const old = await s.callTool("search", {}, signal, { spec: reviewed as never });
          expect(old.content).toEqual([{ type: "text", text: "served by search-v1" }]);
          const now = await s.callTool("search", {}, signal, { spec: pending as never });
          expect(now.content).toEqual([{ type: "text", text: "served by search-v2" }]);
        } finally {
          await s.close();
        }
      } finally {
        await mcp.stop();
      }
    });

    it("maps -32042 to URL elicitations through onElicit, then retries once", async () => {
      let attempts = 0;
      const mcp = await startFakeMcpServer({
        tools: [
          {
            name: "pay",
            description: "Pays",
            handler: () => {
              attempts++;
              if (attempts === 1) {
                throw new FakeMcpRpcError(-32042, "browser step needed", {
                  elicitations: [
                    {
                      mode: "url",
                      message: "Confirm the payment",
                      url: "https://pay.example.com/confirm",
                      elicitationId: "e1",
                    },
                  ],
                });
              }
              return { content: [{ type: "text", text: "paid" }] };
            },
          },
        ],
      });
      const asked: unknown[] = [];
      try {
        const s = await connector().open(
          openArgs({
            endpoint: { url: mcp.url },
            onElicit: async (req) => {
              asked.push(req);
              return { action: "accept" };
            },
          }),
        );
        try {
          const r = await s.callTool("pay", {}, new AbortController().signal);
          expect(r.content).toEqual([{ type: "text", text: "paid" }]);
        } finally {
          await s.close();
        }
        expect(asked).toEqual([
          {
            mode: "url",
            message: "Confirm the payment",
            url: "https://pay.example.com/confirm",
            elicitationId: "e1",
          },
        ]);
        expect(attempts).toBe(2);
      } finally {
        await mcp.stop();
      }
    });

    it("a > 1 MB notesText is accepted by preview and install and summarized in views", async () => {
      const mcp = await startFakeMcpServer({
        tools: [{ name: "search", description: "Search things" }],
        requireBearer: "tok",
      });
      try {
        const endpoint = { url: mcp.url, notesText: "n".repeat(1_500_000) };
        const base = `/api/v1/orgs/${orgId}/connectors`;
        const pv = await root({
          method: "POST",
          url: `${base}/preview`,
          payload: { connector: "fake", endpoint },
        });
        expect(pv.statusCode, pv.body.slice(0, 300)).toBe(200);
        const created = await root({
          method: "POST",
          url: base,
          payload: {
            name: "Big",
            slug: "big",
            connector: "fake",
            endpoint,
            auth: { type: "bearer", ownership: "org" },
            credential: { token: "tok" },
          },
        });
        expect(created.statusCode, created.body.slice(0, 300)).toBe(201);
        const id = (created.json() as { connector: { id: string } }).connector.id;
        const one = await root({ method: "GET", url: `${base}/${id}` });
        const list = await root({ method: "GET", url: base });
        for (const body of [created.body, one.body, list.body]) {
          expect(body).not.toContain("nnnnn");
          expect(body.length).toBeLessThan(200_000);
        }
        const ep = (one.json() as { connector: { endpoint: Record<string, unknown> } }).connector
          .endpoint;
        expect(ep.notesTextBytes).toBe(1_500_000);
        expect(ep.notesTextSha256).toBe(
          createHash("sha256").update(endpoint.notesText).digest("hex"),
        );
        expect(ep.notesText).toBeUndefined();
      } finally {
        await mcp.stop();
      }
    });
  });

  describe("fake-object-store", () => {
    const store = () => provider<ObjectStore>("object-store", "fake-object-store");

    it("is the kernel's storage: put / get / range / list / delete", async () => {
      expect(k.storage.available).toBe(true);
      const s = store();
      const key = `t/${randomUUID()}/a.txt`;
      await s.put(key, new TextEncoder().encode("hello world"), { contentType: "text/plain" });
      expect(await s.head(key)).toMatchObject({ key, size: 11, contentType: "text/plain" });
      const part = await s.get(key, { range: { start: 0, end: 4 } });
      expect(part?.head.size).toBe(11);
      expect(await new Response(part?.body).text()).toBe("hello");
      expect((await s.list(key.slice(0, -5))).items.map((i) => i.key)).toEqual([key]);
      expect(await s.deletePrefix(key.slice(0, -5))).toBe(1);
      expect(await s.get(key)).toBeNull();
    });

    it("presignPut is a POST policy whose size the store enforces; presignGet downloads", async () => {
      const s = store();
      const key = `t/${randomUUID()}/up.bin`;
      const up = await s.presignPut(key, { contentType: "image/png", maxSize: 4, ttlSeconds: 60 });
      expect(up.method).toBe("POST");
      const post = (bytes: number) => {
        const form = new FormData();
        for (const [f, v] of Object.entries(up.fields ?? {})) form.append(f, v);
        form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        return fetch(up.url, { method: "POST", body: form });
      };
      expect((await post(5)).status).toBeGreaterThanOrEqual(400);
      expect((await post(4)).status).toBeLessThan(300);
      const url = await s.presignGet(key, { ttlSeconds: 60, downloadName: "x.png" });
      const got = await fetch(url);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-disposition")).toContain('filename="x.png"');
      await expect(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal POST-policy variable
        s.presignPut("t/${filename}", { contentType: "text/plain", maxSize: 1, ttlSeconds: 60 }),
      ).rejects.toThrow("${");
    });
  });

  describe("fake-tools-ui", () => {
    it("registers its tool and the tasks view; write feeds the view", async () => {
      const tools = k.host.tools().filter((t) => t.plugin === "fake-tools-ui");
      expect(tools.map((t) => t.spec.name)).toEqual(["write"]);
      const write = tools.find((t) => t.spec.name === "write");
      const orgId = randomUUID();
      const r = await write?.handler(
        {
          items: [
            { text: "a", status: "completed" },
            { text: "b", status: "pending" },
          ],
        },
        toolCtx(orgId, "c1"),
      );
      expect(r).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("2 items") }],
      });
      const view = k.host.uiContributions().find((c) => c.plugin === "fake-tools-ui");
      expect(view?.contribution).toMatchObject({
        id: "tasks",
        place: "conversation",
        kind: "view",
      });
      expect(
        await view?.render?.({
          orgId,
          accountId: randomUUID(),
          role: "member",
          conversationId: "c1",
          locale: "en",
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ badge: "1/2" });
      await expect(write?.handler({ items: "x" }, toolCtx(orgId, "c1"))).rejects.toMatchObject({
        name: "ToolError",
      });
    });
  });

  describe("fake-storage-user", () => {
    it("note / read_note go through ctx.storage under the extension's prefix", async () => {
      const tool = (name: string) =>
        k.host.tools().find((t) => t.plugin === "fake-storage-user" && t.spec.name === name);
      const orgId = randomUUID();
      const read = tool("read_note");
      expect(await read?.handler({}, toolCtx(orgId, "c2"))).toEqual({
        content: [{ type: "text", text: "There is no note yet." }],
      });
      await tool("note")?.handler({ text: "remember" }, toolCtx(orgId, "c2"));
      const store = provider<ObjectStore>("object-store", "fake-object-store");
      const got = await store.get(`plugins/fake-storage-user/${orgId}/notes/c2.txt`);
      expect(await new Response(got?.body).text()).toBe("remember");
      expect(await read?.handler({}, toolCtx(orgId, "c2"))).toEqual({
        content: [{ type: "text", text: "remember" }],
      });
    });
  });

  describe("fake-embed", () => {
    it("declares both embeds; pages are public, data routes need a token", async () => {
      const embeds = k.host
        .uiContributions()
        .filter((c) => c.plugin === "fake-embed")
        .map((c) => [c.contribution.id, c.contribution.place, c.contribution.kind]);
      expect(embeds).toEqual([
        ["panel", "page", "embed"],
        ["panel-conv", "conversation", "embed"],
      ]);
      const page = await k.http.inject({ method: "GET", url: "/plugins/fake-embed/ui/panel" });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain('src="./panel.js"');
      const js = await k.http.inject({ method: "GET", url: "/plugins/fake-embed/ui/panel.js" });
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-type"]).toContain("text/javascript");
      for (const [method, url] of [
        ["GET", "/plugins/fake-embed/ui/claims"],
        ["GET", "/plugins/fake-embed/ui/events"],
        ["POST", "/plugins/fake-embed/ui/events"],
      ] as const) {
        const r = await k.http.inject({
          method,
          url,
          headers: { authorization: "Bearer garbage" },
          ...(method === "POST" && { payload: { text: "x" } }),
        });
        expect(r.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it("with a token the kernel issued: claims, publish and the SSE stream (ready, event)", async () => {
      const en = await root({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/fake-embed`,
        payload: { enabled: true },
      });
      expect(en.statusCode, en.body).toBe(200);
      const issued = await root({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/ui/embeds/fake-embed/panel/token`,
        payload: {},
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const { token, src } = issued.json() as { token: string; src: string };
      expect(src).toBe("/plugin-ui/fake-embed/panel");
      const authorization = `Bearer ${token}`;
      const claims = await k.http.inject({
        method: "GET",
        url: "/plugins/fake-embed/ui/claims",
        headers: { authorization },
      });
      expect(claims.statusCode, claims.body).toBe(200);
      expect(claims.json()).toMatchObject({ plugin: "fake-embed", orgId, contribution: "panel" });

      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${k.port}/plugins/fake-embed/ui/events`, {
        headers: { authorization },
        signal: ac.signal,
      });
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let text = "";
        const until = async (needle: string) => {
          while (!text.includes(needle)) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`stream ended before ${needle}`);
            text += dec.decode(value, { stream: true });
          }
        };
        await until("event: ready");
        const pub = await k.http.inject({
          method: "POST",
          url: "/plugins/fake-embed/ui/events",
          headers: { authorization },
          payload: { text: "hello" },
        });
        expect(pub.statusCode, pub.body).toBe(202);
        await until('data: {"text":"hello"}');
        expect(text).toContain("event: event");
      } finally {
        ac.abort();
      }
    });
  });

  describe("fake-dep-provider / fake-dep-requirer", () => {
    it("the requirer loads on the provider's point", async () => {
      expect(provider<{ ping(): string }>("counter", "fake-dep-provider").ping()).toBe(
        "pong from fake-dep-provider",
      );
      expect(k.host.current("fake-dep-requirer")).toBeDefined();
      const r = await k.http.inject({ method: "GET", url: "/plugins/fake-dep-requirer/ping" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toBe("pong from fake-dep-provider");
    });
  });
});

describe("packed, as bootstrap packages", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: Kernel;
  let dir: string;
  let bootDir: string;

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    dir = await mkdtemp(join(tmpdir(), "testing-fixtures-boot-ext-"));
    bootDir = await mkdtemp(join(tmpdir(), "testing-fixtures-boot-"));
    const plugins: BootstrapEntry[] = [];
    for (const name of ["fake-bootstrap-a", "fake-bootstrap-b"] as const) {
      const bytes = packed.get(name) as Uint8Array;
      const entry: BootstrapEntry = {
        name,
        source: "workspace",
        path: `packages/testing/fixtures/extensions/${name}`,
        version: "0.1.0",
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        required: true,
      };
      await writeFile(join(bootDir, bootstrapFileName(entry)), bytes);
      plugins.push(entry);
    }
    const config = baseConfig(pgc.url, rd.url, {
      roles: ["api", "worker"],
      extensions: [],
      extensionHost: { dir },
      // Only the object store is configured: the model provider stays pending configuration
      extensionConfig: { "fake-bootstrap-b": { bucket: "b1", secretKey: "s" } },
    });
    k = await createKernel(config, {
      env: {},
      logger: silent(),
      bootstrapDir: bootDir,
      bootstrapManifest: { schemaVersion: 1, plugins },
    });
    await k.start();
  }, 300_000);

  afterAll(async () => {
    await k?.stop();
    for (const d of [dir, bootDir]) if (d) await rm(d, { recursive: true, force: true });
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  it("fake-bootstrap-b loads from its package and serves as the kernel's storage", async () => {
    expect(k.host.sourceOf("fake-bootstrap-b")).toBe("install");
    expect(k.storage.available).toBe(true);
    const store = k.host.list("object-store").find((e) => e.plugin === "fake-bootstrap-b")
      ?.impl as ObjectStore;
    await store.put("a/1", new TextEncoder().encode("one"), { contentType: "text/plain" });
    await store.put("a/2", new TextEncoder().encode("two"), { contentType: "text/plain" });
    const page = await store.list("a/", { limit: 1 });
    expect(page.items.map((i) => i.key)).toEqual(["a/1"]);
    const next = await store.list("a/", { limit: 1, ...(page.cursor && { cursor: page.cursor }) });
    expect(next.items.map((i) => i.key)).toEqual(["a/2"]);
    expect(await new Response((await store.get("a/2", { range: { start: 1 } }))?.body).text()).toBe(
      "wo",
    );
    expect(await store.head("a/1")).toEqual({ key: "a/1", size: 3, contentType: "text/plain" });
    expect(await store.deletePrefix("a/")).toBe(2);
  });

  it("fake-bootstrap-a is installed but pending configuration until its secret is set", async () => {
    const client = new pg.Client({ connectionString: pgc.url });
    await client.connect();
    try {
      const rows = await client.query(
        "SELECT plugin, state, reason FROM capybara.extension_replica_status ORDER BY plugin",
      );
      expect(rows.rows).toEqual([
        { plugin: "fake-bootstrap-a", state: "pending", reason: "config" },
        { plugin: "fake-bootstrap-b", state: "loaded", reason: null },
      ]);
      const installs = await client.query(
        "SELECT name, source, required FROM capybara.extension_installs ORDER BY name",
      );
      expect(installs.rows).toEqual([
        { name: "fake-bootstrap-a", source: "bootstrap", required: true },
        { name: "fake-bootstrap-b", source: "bootstrap", required: true },
      ]);
    } finally {
      await client.end();
    }
    expect(k.host.list("model-provider").some((e) => e.plugin === "fake-bootstrap-a")).toBe(false);
  });

  it("fake-bootstrap-a's provider answers once loaded (in-process check of the bundle)", async () => {
    const mod = (await import(fakeExtensionEntry("fake-bootstrap-a"))) as {
      default: { setup(ctx: unknown): void };
    };
    let impl: ModelProvider | undefined;
    mod.default.setup({
      config: { apiKey: "k" },
      provide: (_p: string, i: ModelProvider) => {
        impl = i;
      },
    });
    expect((await impl?.listModels())?.map((m) => m.id)).toEqual(["fake-a-1"]);
    const events = [];
    for await (const e of impl?.stream({} as never, { signal: new AbortController().signal }) ??
      []) {
      events.push(e.type);
    }
    expect(events).toEqual(["text_delta", "message_complete"]);
  });
});
