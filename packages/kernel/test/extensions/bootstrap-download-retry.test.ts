import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MergedBootstrapManifest } from "../../src/extensions/bootstrap-extra.js";
import {
  type BootstrapResolveOptions,
  resolveBootstrapPackages,
} from "../../src/extensions/bootstrap-packages.js";

// The bootstrap step's npm downloads (issue #761): a transient failure (connection reset, HTTP
// 5xx) of the registry lookup or the tarball is retried a few times; a 404 or a package that
// differs from its pin is final at once; the error of the last attempt names the plugin.

const bytes = (s: string) => new TextEncoder().encode(s);
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

const A = bytes("tgz of plugin-a 1.0.0");
const B = bytes("tgz of plugin-b 1.0.0");

/** How the next request of a path fails: an HTTP status, or the connection is dropped. */
type Failure = number | "reset";

let server: Server;
let url: string;
/** Failures still to serve, per request path, in order (consumed one per request). */
const failures = new Map<string, Failure[]>();
/** Every request path, in order of arrival. */
const requests: string[] = [];
/** Packages served: request path of the packument -> [name, tgz]. */
const packages: Record<string, [string, Uint8Array]> = {
  "/@acme%2fplugin-a": ["@acme/plugin-a", A],
  "/@acme%2fplugin-b": ["@acme/plugin-b", B],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    const next = failures.get(path)?.shift();
    if (next === "reset") {
      req.socket.destroy();
      return;
    }
    if (next !== undefined) {
      res.writeHead(next).end();
      return;
    }
    const pkg = packages[path];
    if (pkg !== undefined) {
      const [name, tgz] = pkg;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": { dist: { tarball: `${url}${path}/-/1.0.0.tgz`, integrity: sri(tgz) } },
          },
        }),
      );
      return;
    }
    const tgz = Object.entries(packages).find(([p]) => path === `${p}/-/1.0.0.tgz`)?.[1][1];
    if (tgz !== undefined) {
      res.writeHead(200).end(Buffer.from(tgz));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  failures.clear();
  requests.length = 0;
});

const entry = (name: string, npm: string, integrity: string) => ({
  name,
  source: "npm" as const,
  npm,
  version: "1.0.0",
  integrity,
  required: true,
});
const manifest = (...plugins: ReturnType<typeof entry>[]): MergedBootstrapManifest => ({
  schemaVersion: 1,
  plugins,
});
const A_ENTRY = entry("plugin-a", "@acme/plugin-a", sri(A));
const B_ENTRY = entry("plugin-b", "@acme/plugin-b", sri(B));

const warnings: { msg: string; fields: unknown }[] = [];
const options = (over: Partial<BootstrapResolveOptions> = {}): BootstrapResolveOptions => {
  warnings.length = 0;
  return {
    config: {
      packages: { npmRegistry: url, maxBytes: 1024 * 1024 },
      marketplaces: { allowInsecureLoopback: true, allowPrivateHosts: [], tokens: {} },
      net: {},
    } as unknown as BootstrapResolveOptions["config"],
    // No waits in tests: the delays only space the attempts out
    retryDelaysMs: [0, 0, 0],
    log: { warn: (msg: string, fields?: unknown) => warnings.push({ msg, fields }) },
    ...over,
  };
};
const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as Error & { code?: string },
  );

describe("resolveBootstrapPackages: npm download retries", () => {
  it("retries a lookup and a tarball that fail transiently, then obtains every package", async () => {
    failures.set("/@acme%2fplugin-a", ["reset", 503]);
    failures.set("/@acme%2fplugin-b/-/1.0.0.tgz", [502, "reset", 500]);
    const out = await resolveBootstrapPackages(manifest(A_ENTRY, B_ENTRY), options());
    expect(Buffer.from(out.get("plugin-a") ?? []).equals(Buffer.from(A))).toBe(true);
    expect(Buffer.from(out.get("plugin-b") ?? []).equals(Buffer.from(B))).toBe(true);
    // plugin-a: two failed lookups, then lookup + tarball; plugin-b: lookup + failed tarball, three times
    expect(requests.filter((r) => r === "/@acme%2fplugin-a")).toHaveLength(3);
    expect(requests.filter((r) => r === "/@acme%2fplugin-b/-/1.0.0.tgz")).toHaveLength(4);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]?.fields).toMatchObject({
      plugin: "plugin-a",
      package: "@acme/plugin-a@1.0.0",
      attempt: 1,
    });
  });

  it("gives up after the last attempt with an error naming the plugin and the attempts", async () => {
    failures.set("/@acme%2fplugin-a/-/1.0.0.tgz", [503, 503, 503, 503, 503]);
    const err = await failureOf(resolveBootstrapPackages(manifest(A_ENTRY), options()));
    expect(err.code).toBe("bootstrap.download_failed");
    expect(err.message).toContain("Bootstrap plugin plugin-a 1.0.0");
    expect(err.message).toContain("@acme/plugin-a@1.0.0");
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("4 attempts");
    expect(requests.filter((r) => r === "/@acme%2fplugin-a/-/1.0.0.tgz")).toHaveLength(4);
    // one failure left over: no fifth attempt
    expect(failures.get("/@acme%2fplugin-a/-/1.0.0.tgz")).toHaveLength(1);
  });

  it("never retries a 404", async () => {
    const missing = entry("plugin-c", "@acme/plugin-c", sri(bytes("c")));
    const err = await failureOf(resolveBootstrapPackages(manifest(missing), options()));
    expect(err.code).toBe("bootstrap.download_failed");
    expect(err.message).toContain("Bootstrap plugin plugin-c");
    expect(err.message).toContain("HTTP 404");
    expect(err.message).not.toContain("attempts");
    expect(requests).toEqual(["/@acme%2fplugin-c"]);
    expect(warnings).toHaveLength(0);
  });

  it("never retries a refused connection (nothing listens: a wrong URL or a registry that is down)", async () => {
    const down = createServer();
    await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
    const downUrl = `http://127.0.0.1:${(down.address() as AddressInfo).port}`;
    await new Promise<void>((r) => down.close(() => r()));
    const o = options();
    o.config = { ...o.config, packages: { npmRegistry: downUrl, maxBytes: 1024 } };
    const err = await failureOf(resolveBootstrapPackages(manifest(A_ENTRY), o));
    expect(err.code).toBe("bootstrap.download_failed");
    expect(err.message).toContain("Bootstrap plugin plugin-a");
    expect(err.message).not.toContain("attempts");
    expect(warnings).toHaveLength(0);
  });

  it("never retries a package that differs from its pin", async () => {
    const pinnedOther = entry("plugin-a", "@acme/plugin-a", sri(bytes("another tgz")));
    const err = await failureOf(resolveBootstrapPackages(manifest(pinnedOther), options()));
    expect(err.code).toBe("bootstrap.integrity_mismatch");
    expect(err.message).toContain("Bootstrap plugin plugin-a");
    expect(requests).toEqual(["/@acme%2fplugin-a", "/@acme%2fplugin-a/-/1.0.0.tgz"]);
    expect(warnings).toHaveLength(0);
  });

  it("stops retrying when the run is aborted", async () => {
    failures.set("/@acme%2fplugin-a", [503, 503, 503, 503]);
    const ac = new AbortController();
    const err = await failureOf(
      resolveBootstrapPackages(
        manifest(A_ENTRY),
        options({
          signal: ac.signal,
          log: { warn: () => ac.abort(new Error("lock lost")) },
          retryDelaysMs: [60_000, 60_000, 60_000],
        }),
      ),
    );
    // the wait before the second attempt ends at the abort: no second request
    expect(err.name).toBe("AbortError");
    expect(requests).toEqual(["/@acme%2fplugin-a"]);
  });
});
