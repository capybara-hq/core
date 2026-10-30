import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapManifest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKernelApp, startKernelApp } from "../../src/app.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { createLogger } from "../../src/log.js";
import { SLOW_GATES_KEY, type SlowGates } from "../fixtures/plugins/slow/index.js";
import { lifePkg } from "../helpers/plugin-packages.js";

/**
 * Start order (nest kernel spec §4): nothing is served before the bootstrap step and the extension
 * load finish, and a required bootstrap failure rejects the start, releasing Redis and the pool.
 */

let pgc: TestContainer;
let rd: TestContainer;
let bootstrapDir: string;
const apps: NestFastifyApplication[] = [];
const servers: HttpServer[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");
const SLOW = fileURLToPath(new URL("../fixtures/plugins/slow/index.ts", import.meta.url));
const silent = () => createLogger("error", { write: () => {} });

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

/**
 * An npm registry serving `pkg` (or nothing: 404) that holds every request until `gate` resolves;
 * `entered` resolves when the first request arrives.
 */
async function gatedRegistry(
  gate: Promise<void>,
  pkg?: { name: string; version: string; tgz: Uint8Array },
): Promise<{ url: string; entered: Promise<void> }> {
  const entered = deferred();
  let base = "";
  const server = createHttpServer((req, res) => {
    entered.resolve();
    req.resume();
    void gate.then(() => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0] as string).slice(1);
      if (pkg === undefined) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
      } else if (path.includes("/-/")) {
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(pkg.tgz);
      } else {
        const dist = { tarball: `${base}/${pkg.name}/-/package.tgz`, integrity: sri(pkg.tgz) };
        const version = { name: pkg.name, version: pkg.version, dist };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            name: pkg.name,
            "dist-tags": { latest: pkg.version },
            versions: { [pkg.version]: version },
          }),
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: base, entered: entered.promise };
}

const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** A manifest with one required npm entry. */
function manifest(e: {
  name: string;
  npm: string;
  version: string;
  integrity: string;
}): BootstrapManifest {
  return {
    schemaVersion: 1,
    marketplace: {
      url: "https://github.com/capybara-hq/plugins.git",
      commit: "0000000000000000000000000000000000000000",
    },
    plugins: [{ ...e, source: "npm", required: true }],
  };
}

/** An entry no registry of these tests serves. */
const ABSENT = {
  name: "absent",
  npm: "@test/plugin-absent",
  version: "0.1.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
};

const cfg = (over: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 3 },
    redis: { url: rd.url },
    masterKey,
    marketplaces: { official: { enabled: false } },
    extensionPermissions: { autoApprove: true },
    ...over,
  });

async function redisClients(): Promise<number> {
  const r = new Redis(rd.url);
  try {
    const list = (await r.call("CLIENT", "LIST")) as string;
    // minus this connection
    return list.split("\n").filter((l) => l.trim() !== "").length - 1;
  } finally {
    r.disconnect();
  }
}

async function kernelPgConnections(): Promise<number> {
  const c = new pg.Client({ connectionString: pgc.url });
  await c.connect();
  try {
    const r = await c.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where application_name = 'capybara-kernel' and datname = current_database()",
    );
    return r.rows[0]?.n ?? 0;
  } finally {
    await c.end();
  }
}

async function eventually(fn: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  bootstrapDir = await mkdtemp(join(tmpdir(), "kernel-start-order-"));
}, 120_000);
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (servers.length > 0) {
    const s = servers.pop() as HttpServer;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
afterAll(async () => {
  await rm(bootstrapDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("start order", () => {
  it("nothing listens until the bootstrap step and the extension load finish", async () => {
    const port = await freePort();
    const bootstrapGate = deferred();
    const tgz = await lifePkg({ name: "gated", version: "1.0.0" });
    const npm = "@test/plugin-gated";
    const registry = await gatedRegistry(bootstrapGate.promise, {
      name: npm,
      version: "1.0.0",
      tgz,
    });
    const slow = { entered: deferred(), gate: deferred() };
    const key = `start-order-${Date.now()}`;
    const g = globalThis as { [SLOW_GATES_KEY]?: Map<string, SlowGates> };
    g[SLOW_GATES_KEY] ??= new Map();
    g[SLOW_GATES_KEY].set(key, slow);
    try {
      const starting = startKernelApp(
        cfg({
          http: { port },
          packages: { npmRegistry: registry.url },
          extensions: [SLOW],
          extensionConfig: { slow: { key } },
        }),
        {
          env: {},
          logger: silent(),
          bootstrap: { dir: bootstrapDir },
          bootstrapManifest: manifest({
            name: "gated",
            npm,
            version: "1.0.0",
            integrity: sri(tgz),
          }),
        },
      );
      starting.then((app) => apps.push(app)).catch(() => {});

      // the bootstrap step is waiting for the registry: nothing listens
      await registry.entered;
      expect(await canConnect(port)).toBe(false);
      bootstrapGate.resolve();

      // the bootstrap plugin is installed; the extension load is now waiting in the slow setup
      await slow.entered.promise;
      expect(await canConnect(port)).toBe(false);
      slow.gate.resolve();

      await starting;
      expect(await canConnect(port)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(200);
    } finally {
      bootstrapGate.resolve();
      slow.gate.resolve();
      g[SLOW_GATES_KEY]?.delete(key);
    }
  }, 60_000);

  it("a required bootstrap failure rejects createKernelApp and closes Redis and the pool", async () => {
    const registry = await gatedRegistry(Promise.resolve());
    const baseline = await redisClients();
    await expect(
      createKernelApp(cfg({ packages: { npmRegistry: registry.url } }), {
        env: {},
        logger: silent(),
        bootstrap: { dir: bootstrapDir },
        bootstrapManifest: manifest(ABSENT),
      }),
    ).rejects.toMatchObject({ code: "bootstrap.download_failed" });
    expect(await eventually(async () => (await redisClients()) === baseline)).toBe(true);
    expect(await eventually(async () => (await kernelPgConnections()) === 0)).toBe(true);
  }, 60_000);

  it("a required bootstrap failure keeps startKernelApp from listening", async () => {
    const port = await freePort();
    const registry = await gatedRegistry(Promise.resolve());
    await expect(
      startKernelApp(cfg({ http: { port }, packages: { npmRegistry: registry.url } }), {
        env: {},
        logger: silent(),
        bootstrap: { dir: bootstrapDir },
        bootstrapManifest: manifest(ABSENT),
      }),
    ).rejects.toMatchObject({ code: "bootstrap.download_failed" });
    expect(await canConnect(port)).toBe(false);
  }, 60_000);
});
