import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { enableExtensions, type Req } from "../helpers/runs.js";
import { clientPlugin, importClientPlugin, sha256 } from "./client-env.js";

/**
 * The client build in the permission reviews (client extensions spec §5.4): the admin catalog item
 * detail carries each version's client build (files with sizes, total, client API version), what
 * the confirmation of an org's upload shows while it waits; the org extension list carries the
 * running package's build for org admins (the Sheet's review), never for members.
 */

let env: OrgEnv;
let itemId: string;
let pageSha: string;

const PAGE = "rb-page";
const PENDING = "rb-pending";

interface Summary {
  files: { path: string; bytes: number }[];
  totalBytes: number;
  apiVersion: number;
}

/** The stored row's sizes, as the expected summary in load order (entry, styles, assets). */
async function expected(sha: string): Promise<Summary> {
  const row = await env.db
    .selectFrom("extension_client_builds")
    .selectAll()
    .where("package_sha256", "=", sha)
    .executeTakeFirstOrThrow();
  const sizes = row.sizes as Record<string, number>;
  const files = [...(row.entry === null ? [] : [row.entry]), ...row.styles, ...row.assets].map(
    (path) => ({ path, bytes: sizes[path] as number }),
  );
  return { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0), apiVersion: 1 };
}

beforeAll(async () => {
  env = await startOrgEnv();
  const page = await clientPlugin({
    name: PAGE,
    components: [{ id: "brand", slot: "shell.brand" }],
    decorated: true,
  });
  pageSha = sha256(page);
  itemId = await importClientPlugin(env, page, PAGE);
  await enableExtensions(env.db, env.orgId, PAGE);
});

afterAll(async () => {
  await env?.stop();
});

const versionClient = async (id: string, version = "1.0.0") => {
  const r = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${id}` });
  expect(r.statusCode, r.body).toBe(200);
  const v = (
    r.json() as { versions: { version: string; client: Summary | null; extensionSha256: string }[] }
  ).versions.find((x) => x.version === version);
  return v;
};

describe("the admin catalog item detail", () => {
  it("carries each version's client build with file sizes, in load order", async () => {
    const v = await versionClient(itemId);
    expect(v?.client).toEqual(await expected(pageSha));
    expect(v?.client?.files.map((f) => f.path)).toEqual([
      "./dist/client/client.mjs",
      "./dist/client/styles/a.css",
      "./dist/client/assets/logo.svg",
    ]);
    expect(v?.client?.files.every((f) => f.bytes > 0)).toBe(true);
  });

  it("an org's upload waiting for the super admin shows its pending package's build", async () => {
    const bytes = await clientPlugin({
      name: PENDING,
      components: [{ id: "hero", slot: "conversation.empty" }],
    });
    const base = `/api/v1/orgs/${env.orgId}/catalog/uploads`;
    const p = await env.boss({
      method: "POST",
      url: `${base}/file`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });
    expect(p.statusCode, p.body).toBe(200);
    const prepared = p.json() as { stagingId: string; review: { reviewHash: string } };
    const c = await env.boss({
      method: "POST",
      url: `${base}/${prepared.stagingId}/confirm`,
      payload: { reviewHash: prepared.review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    const out = c.json() as { outcome: string; item: { id: string } };
    expect(out.outcome).toBe("pending");
    const v = await versionClient(out.item.id);
    expect(v?.extensionSha256).toBe(sha256(bytes));
    expect(v?.client).toEqual(await expected(sha256(bytes)));
  });

  it("a version without client code has client null", async () => {
    const r = await env.root({ method: "GET", url: "/api/v1/admin/catalog/items" });
    const items = (r.json() as { items: { id: string; name: string }[] }).items;
    // a bootstrap or test plugin without client code, when the deployment lists one
    for (const i of items.filter((x) => x.name !== PAGE && x.name !== PENDING)) {
      const d = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${i.id}` });
      for (const v of (d.json() as { versions: { client: unknown }[] }).versions) {
        expect(v.client).toBeNull();
      }
    }
  });
});

describe("the org extension list", () => {
  const list = async (req: Req) => {
    const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/extensions` });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { extensions: Record<string, unknown>[] }).extensions;
  };

  it("org admins get the running package's client build; members do not", async () => {
    const admin = (await list(env.boss)).find((e) => e.plugin === PAGE);
    expect(admin?.client).toEqual(await expected(pageSha));
    const member = (await list(env.mem)).find((e) => e.plugin === PAGE);
    expect(member).toBeDefined();
    expect(member && "client" in member).toBe(false);
  });

  it("an extension without client code has client null", async () => {
    for (const e of (await list(env.boss)).filter((x) => x.plugin !== PAGE)) {
      expect(e.client).toBeNull();
    }
  });
  it("a bootstrap import of a plugin with client code is refused, object storage or not", async () => {
    const bytes = await clientPlugin({
      name: "rb-boot",
      components: [{ id: "brand", slot: "shell.brand" }],
    });
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await expect(
      env.k.app
        .get(PluginImport)
        .prepare(null, bytes, { kind: "bootstrap", ref: "rb-boot@1.0.0", integrity }),
    ).rejects.toMatchObject({
      code: "client.invalid",
      message: expect.stringContaining(
        "Bootstrap plugin rb-boot ships client code (extension.client), which a bootstrap plugin may not carry",
      ),
    });
  });
});
