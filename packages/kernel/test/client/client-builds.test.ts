import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_MANIFEST_FILE,
  type PluginClientSection,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { packFixture } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import { ClientBuilds } from "../../src/client/client-builds.service.js";
import { checkClientFiles } from "../../src/client/client-files.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionBlobs } from "../../src/extensions/blobs.js";
import { ExtensionInstalls } from "../../src/extensions/installs.js";
import { readExtensionPackage } from "../../src/extensions/package.js";
import { unpackPackageTgz } from "../../src/packages/tgz.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { tgz } from "../helpers/plugin-packages.js";
import type { Req } from "../helpers/runs.js";

/**
 * Client builds (client extensions spec §9.1, plan Task 8): a package with client code stores its
 * client files under `deployment/platform/client/<plugin>/<sha256>/` and one
 * `extension_client_builds` row whose integrity was recomputed from the bytes; a tampered,
 * undeclared or invalid client section refuses the whole package; without object storage it is
 * refused; the files go with the package row.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const sha384 = (data: Uint8Array) => `sha384-${createHash("sha384").update(data).digest("base64")}`;
/** The parts of the packed plugin.json the tests change. */
interface PackedManifest {
  extension: { manifest: { permissions: { client?: boolean } }; client: PluginClientSection };
  suggestedAppearance: { theme?: string };
}
const WRAPPED = (css: string) => `@layer extensions {\n${css}\n}\n`;

describe("checkClientFiles", () => {
  const css = enc(WRAPPED("a { b: c }"));
  const js = enc("export default {}");
  const section = (over: Partial<PluginClientSection> = {}): PluginClientSection => ({
    entry: "./dist/client/client.mjs",
    styles: ["./dist/client/styles/a.css"],
    integrity: {
      "./dist/client/client.mjs": sha384(js),
      "./dist/client/styles/a.css": sha384(css),
    },
    apiVersion: 1,
    ...over,
  });
  const files = (extra: Record<string, Uint8Array> = {}) =>
    new Map<string, Uint8Array>(
      Object.entries({
        "dist/client/client.mjs": js,
        "dist/client/styles/a.css": css,
        "dist/index.mjs": js,
        ...extra,
      }),
    );
  const refusal = (s: PluginClientSection, f: Map<string, Uint8Array>) => {
    try {
      checkClientFiles(s, f);
    } catch (e) {
      if (e instanceof ApiError) return [e.code, e.details?.[0]];
      throw e;
    }
    throw new Error("expected a refusal");
  };

  it("returns the files in section order with their sizes and integrity", () => {
    const r = checkClientFiles(section(), files());
    expect(r.files.map((f) => [f.key, f.size])).toEqual([
      ["./dist/client/client.mjs", js.byteLength],
      ["./dist/client/styles/a.css", css.byteLength],
    ]);
    expect(r.total).toBe(js.byteLength + css.byteLength);
  });

  it("refuses an unlisted, a missing or a tampered file", () => {
    expect(refusal(section(), files({ "dist/client/extra.png": js }))).toEqual([
      "client.invalid",
      { file: "./dist/client/extra.png", reason: expect.stringContaining("not listed") },
    ]);
    const missing = files();
    missing.delete("dist/client/styles/a.css");
    expect(refusal(section(), missing)).toEqual([
      "client.invalid",
      { file: "./dist/client/styles/a.css", reason: expect.stringContaining("missing") },
    ]);
    expect(
      refusal(section(), files({ "dist/client/client.mjs": enc("export default 1") })),
    ).toEqual(["client.integrity_mismatch", { file: "./dist/client/client.mjs" }]);
  });

  it("refuses a key the delivery lookup could read two ways", () => {
    for (const asset of [
      "./dist/client/assets/a%2Fb.png",
      "./dist/client/assets/.png",
      "./dist/client/assets/x/../b.png",
      "./dist/client/assets/a b.png",
      "./dist/client/assets/a?.png",
      "./dist/client/assets/a#b.png",
      "./dist/client/assets/café.png",
    ]) {
      const s = section({
        assets: [asset],
        integrity: { ...section().integrity, [asset]: sha384(js) },
      });
      const [code] = refusal(s, files({ [asset.slice(2)]: js }));
      expect(code, asset).toBe("client.invalid");
    }
  });

  it("a stylesheet may use the section's assets and nothing else", () => {
    const png = enc("png");
    const withCss = (text: string) => {
      const data = enc(WRAPPED(text));
      return [
        section({
          assets: ["./dist/client/assets/a.png"],
          integrity: {
            ...section().integrity,
            "./dist/client/styles/a.css": sha384(data),
            "./dist/client/assets/a.png": sha384(png),
          },
        }),
        files({ "dist/client/styles/a.css": data, "dist/client/assets/a.png": png }),
      ] as const;
    };
    expect(() => checkClientFiles(...withCss("a { b: url(../assets/a.png) }"))).not.toThrow();
    expect(refusal(...withCss("a { b: url(../assets/b.png) }"))).toEqual([
      "client.invalid",
      { file: "./dist/client/styles/a.css", reason: expect.stringContaining("not allowed") },
    ]);
  });
});

describe("client builds", { timeout: 240_000 }, () => {
  let env: OrgEnv;
  let packed: Uint8Array;
  let storage: StorageService;

  beforeAll(async () => {
    env = await startOrgEnv();
    storage = env.k.app.get(StorageService);
    const dir = await mkdtemp(join(tmpdir(), "kernel-client-builds-"));
    try {
      packed = (await packFixture("fake-client", dir)).bytes;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await env.db.deleteFrom("extension_packages").where("name", "=", "fake-client").execute();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const errorOf = (r: { statusCode: number; body: string }) => {
    const e = (
      JSON.parse(r.body) as { error?: { code: string; message: string; details?: unknown[] } }
    ).error;
    return { status: r.statusCode, code: e?.code, message: e?.message, details: e?.details };
  };

  const prepare = (
    bytes: Uint8Array,
    req: Req = env.root,
    url = "/api/v1/admin/catalog/import/file",
  ) =>
    req({
      method: "POST",
      url,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });

  /** The package's files (paths relative to the package root), changed by `f`, packed again. */
  async function changed(
    f: (files: Map<string, Uint8Array>, manifest: PackedManifest) => void,
  ): Promise<Uint8Array> {
    const files = new Map<string, Uint8Array>(
      (await unpackPackageTgz(packed, { maxBytes: 64 * 1024 * 1024 })).map((x) => [x.path, x.data]),
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(files.get(PLUGIN_MANIFEST_FILE)),
    ) as PackedManifest;
    f(files, manifest);
    files.set(PLUGIN_MANIFEST_FILE, enc(JSON.stringify(manifest)));
    return tgz(
      [...files].map(([path, data]) => ({ name: `package/${path}`, data: Buffer.from(data) })),
    );
  }

  const builds = () => env.db.selectFrom("extension_client_builds").selectAll().execute();

  const keysUnder = async (prefix: string) =>
    (await storage.deployment().list(prefix)).items.map((i) => i.key).sort();

  const readObject = async (key: string) => {
    const got = await storage.deployment().get(key);
    if (!got) return null;
    return new Uint8Array(await new Response(got.body).arrayBuffer());
  };

  it("a package with client code stores its files and one build row", async () => {
    const r = await prepare(packed);
    expect(r.statusCode, r.body).toBe(200);
    const review = r.json() as {
      review: {
        extension: {
          sha256: string;
          client?: { files: { path: string; size: number }[]; apiVersion: number };
        };
      };
    };
    const sha = review.review.extension.sha256;
    const files = new Map(
      (await unpackPackageTgz(packed, { maxBytes: 64 * 1024 * 1024 })).map((x) => [x.path, x.data]),
    );
    const manifest = JSON.parse(new TextDecoder().decode(files.get(PLUGIN_MANIFEST_FILE)));
    const section = manifest.extension.client as PluginClientSection;
    const prefix = `platform/client/fake-client/${sha}/`;
    expect(await keysUnder(prefix)).toEqual([`${prefix}client.mjs`, `${prefix}styles/fake.css`]);
    expect(await readObject(`${prefix}client.mjs`)).toEqual(
      new Uint8Array(files.get("dist/client/client.mjs") as Uint8Array),
    );
    expect((await storage.deployment().head(`${prefix}styles/fake.css`))?.contentType).toMatch(
      /^text\/css/,
    );
    const rows = await builds();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      package_sha256: sha,
      plugin: "fake-client",
      entry: "./dist/client/client.mjs",
      styles: ["./dist/client/styles/fake.css"],
      assets: [],
      integrity: section.integrity,
      api_version: section.apiVersion,
      object_prefix: prefix,
    });
    expect(rows[0]?.sizes).toEqual({
      "./dist/client/client.mjs": files.get("dist/client/client.mjs")?.byteLength,
      "./dist/client/styles/fake.css": files.get("dist/client/styles/fake.css")?.byteLength,
    });
    expect(await env.k.app.get(ClientBuilds).byPackage(sha)).toMatchObject({
      packageSha256: sha,
      integrity: section.integrity,
      objectPrefix: prefix,
    });
    // the review's 客户端代码 group: every client file with its size
    expect(review.review.extension.client).toEqual({
      files: [
        { path: "./dist/client/client.mjs", size: rows[0]?.sizes["./dist/client/client.mjs"] },
        {
          path: "./dist/client/styles/fake.css",
          size: rows[0]?.sizes["./dist/client/styles/fake.css"],
        },
      ],
      totalBytes: Object.values(rows[0]?.sizes ?? {}).reduce((a, b) => a + b, 0),
      apiVersion: 1,
    });
  });

  it("storing the same package twice writes one row", async () => {
    const a = await prepare(packed);
    expect(a.statusCode, a.body).toBe(200);
    const b = await prepare(packed);
    expect(b.statusCode, b.body).toBe(200);
    expect(await builds()).toHaveLength(1);
    // a lost object is restored by storing the package again
    const sha = (a.json() as { review: { extension: { sha256: string } } }).review.extension.sha256;
    const prefix = `platform/client/fake-client/${sha}/`;
    await storage.deployment().delete(`${prefix}client.mjs`);
    expect((await prepare(packed)).statusCode).toBe(200);
    expect(await keysUnder(prefix)).toContain(`${prefix}client.mjs`);
    expect(await builds()).toHaveLength(1);
  });

  it("a tampered file refuses the import with client.integrity_mismatch", async () => {
    const bytes = await changed((files) => {
      const js = new Uint8Array(files.get("dist/client/client.mjs") as Uint8Array);
      js[0] = (js[0] as number) ^ 1;
      files.set("dist/client/client.mjs", js);
    });
    const e = errorOf(await prepare(bytes));
    expect([e.status, e.code, e.details]).toEqual([
      400,
      "client.integrity_mismatch",
      [{ file: "./dist/client/client.mjs" }],
    ]);
    expect(await builds()).toEqual([]);
    expect(await keysUnder("platform/client/")).toEqual([]);
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("name", "=", "fake-client")
        .execute(),
    ).toEqual([]);
  });

  it("a client section without permissions.client refuses with client.undeclared", async () => {
    const bytes = await changed((_files, m) => {
      delete m.extension.manifest.permissions.client;
    });
    const e = errorOf(await prepare(bytes));
    expect([e.status, e.code]).toEqual([400, "client.undeclared"]);
    expect(e.message).toContain("permissions.client");
    expect(await builds()).toEqual([]);
  });

  it("an unwrapped stylesheet or one with @import refuses with client.invalid", async () => {
    for (const css of [
      '[data-cap-part~="shell"] { color: red; }\n',
      WRAPPED('@import "https://evil.example/x.css";'),
    ]) {
      const bytes = await changed((files, m) => {
        const data = enc(css);
        files.set("dist/client/styles/fake.css", data);
        // the integrity matches: the stylesheet check is what refuses
        m.extension.client.integrity["./dist/client/styles/fake.css"] = sha384(data);
      });
      const e = errorOf(await prepare(bytes));
      expect([e.status, e.code, (e.details?.[0] as { file?: string })?.file], css).toEqual([
        400,
        "client.invalid",
        "./dist/client/styles/fake.css",
      ]);
    }
    expect(await builds()).toEqual([]);
  });

  it("no object store refuses with storage.unavailable", async () => {
    vi.spyOn(storage, "available", "get").mockReturnValue(false);
    const e = errorOf(await prepare(packed));
    expect([e.status, e.code]).toEqual([503, "storage.unavailable"]);
    vi.restoreAllMocks();
    expect(await builds()).toEqual([]);
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("name", "=", "fake-client")
        .execute(),
    ).toEqual([]);
  });

  it("suggestedAppearance naming a theme the plugin lacks refuses the import", async () => {
    const bytes = await changed((_files, m) => {
      m.suggestedAppearance.theme = "missing";
    });
    const e = errorOf(await prepare(bytes));
    // the catalog's invalid-package refusal (the plan's `plugin.invalid` is this code)
    expect([e.status, e.code]).toEqual([422, "catalog.invalid_manifest"]);
    expect(e.details).toEqual([
      "suggestedAppearance.theme names missing, which is not a theme of the plugin",
    ]);
  });

  it("deleting the package row deletes the client prefix after commit", async () => {
    // an org upload stores its package at prepare; an expired staging drops it (P3-10)
    const r = await prepare(packed, env.boss, `/api/v1/orgs/${env.orgId}/catalog/uploads/file`);
    expect(r.statusCode, r.body).toBe(200);
    const { stagingId, review } = r.json() as {
      stagingId: string;
      review: { extension: { sha256: string } };
    };
    const sha = review.extension.sha256;
    const prefix = `platform/client/fake-client/${sha}/`;
    expect(await keysUnder(prefix)).toHaveLength(2);
    expect(await builds()).toHaveLength(1);
    await env.db
      .updateTable("plugin_import_staging")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` as unknown as Date })
      .where("id", "=", stagingId)
      .execute();
    expect(await env.k.app.get(PluginImport).cleanupExpired()).toBe(1);
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("sha256", "=", sha)
        .execute(),
    ).toEqual([]);
    expect(await builds()).toEqual([]);
    expect(await keysUnder(prefix)).toEqual([]);
  });
  it("a direct extension upload refuses undeclared client code and a missing object store", async () => {
    const installs = env.k.app.get(ExtensionInstalls);
    const refusal = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (e) {
        if (e instanceof ApiError) return [e.status, e.code];
        throw e;
      }
      throw new Error("expected a refusal");
    };
    const undeclared = await changed((_files, m) => {
      delete m.extension.manifest.permissions.client;
    });
    expect(
      await refusal(() => installs.ingest(null, undeclared, { source: "file", ref: "t" })),
    ).toEqual([400, "client.undeclared"]);
    vi.spyOn(storage, "available", "get").mockReturnValue(false);
    expect(
      await refusal(() => installs.ingest(null, packed, { source: "file", ref: "t" })),
    ).toEqual([503, "storage.unavailable"]);
    // ExtensionBlobs.put itself refuses before writing anything
    const pkg = await readExtensionPackage(packed, {
      maxBytes: 64 * 1024 * 1024,
      hostSdkVersion: SDK_VERSION,
    });
    expect(
      await refusal(() =>
        env.k.app.get(ExtensionBlobs).put(pkg, packed, { source: "file", ref: "t", actor: null }),
      ),
    ).toEqual([503, "storage.unavailable"]);
    vi.restoreAllMocks();
    expect(await builds()).toEqual([]);
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("name", "=", "fake-client")
        .execute(),
    ).toEqual([]);
  });

  it("a build's files are not deleted while its package row exists", async () => {
    const r = await prepare(packed);
    expect(r.statusCode, r.body).toBe(200);
    const sha = (r.json() as { review: { extension: { sha256: string } } }).review.extension.sha256;
    const prefix = `platform/client/fake-client/${sha}/`;
    // a concurrent store of the same bytes recorded the row again: the late delete keeps the files
    expect(await env.k.app.get(ClientBuilds).deleteFiles(sha, prefix)).toBe(false);
    expect(await keysUnder(prefix)).toHaveLength(2);
    await env.db.deleteFrom("extension_packages").where("sha256", "=", sha).execute();
    expect(await env.k.app.get(ClientBuilds).deleteFiles(sha, prefix)).toBe(true);
    expect(await keysUnder(prefix)).toEqual([]);
  });
});
