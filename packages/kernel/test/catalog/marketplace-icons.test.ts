import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type FakeGitServer,
  type FakeMarketplace,
  startFakeGitServer,
  startFakeMarketplace,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkMarketplaceIcon,
  gitIconPaths,
  MARKETPLACE_ICON_FETCHES_MAX,
  MARKETPLACE_ICON_MAX_BYTES,
  wantedIcons,
} from "../../src/catalog/marketplace-icons.js";
import { MarketplacesService } from "../../src/catalog/marketplaces.service.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { createOrg } from "../helpers/runs.js";
import { type OrgEnv, setDeployment, startOrgEnv } from "./org-env.js";

// Marketplace entry icons (maintainer decision 2026-11-08): an entry's `icon` (an https URL, or a
// path in a git marketplace's repository) is read on refresh through the marketplace network
// rules, kept in PG when it really is an svg / png within the size cap, and served on the super
// admin routes; a bad icon never fails the refresh. An imported plugin shows its catalog icon.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>';
const SVG2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle/></svg>';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-a-png"),
]);
const BIG = `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(MARKETPLACE_ICON_MAX_BYTES)}</svg>`;

let env: OrgEnv;
let market: FakeMarketplace;
let git: FakeGitServer;
let icons: Server;
let iconBase: string;
/** Paths the icon server was asked for. */
const iconHits: string[] = [];

const ICON_FILES: Record<string, { type: string; body: string | Buffer }> = {
  "/icon.svg": { type: "image/svg+xml", body: SVG },
  "/logo.png": { type: "image/png", body: PNG },
  "/big.svg": { type: "image/svg+xml", body: BIG },
  // claims png, is not one
  "/fake.png": { type: "image/png", body: "<html>nope</html>" },
  // claims svg, is html
  "/page.svg": { type: "image/svg+xml", body: "<html><script>1</script></html>" },
};

const entry = (name: string, icon?: string) => ({
  name,
  summary: { en: `${name} plugin` },
  version: "1.0.0",
  source: { git: { url: "https://git.example.com/acme/x.git", ref: "main" } },
  ...(icon !== undefined && { icon }),
});

beforeAll(async () => {
  icons = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] as string;
    iconHits.push(path);
    if (path === "/redirect.svg") {
      res.writeHead(302, { location: "/icon.svg" }).end();
      return;
    }
    const f = ICON_FILES[path];
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": f.type }).end(f.body);
  });
  await new Promise<void>((resolve) => icons.listen(0, "127.0.0.1", resolve));
  iconBase = `http://127.0.0.1:${(icons.address() as AddressInfo).port}`;
  market = await startFakeMarketplace({ manifest: { schemaVersion: 1, name: "M", plugins: [] } });
  git = await startFakeGitServer();
  env = await startOrgEnv({ marketplaces: { allowInsecureLoopback: true } });
}, 240_000);

afterAll(async () => {
  await env?.stop();
  await Promise.all([market?.stop(), git?.stop()]);
  await new Promise<void>((resolve) => (icons ? icons.close(() => resolve()) : resolve()));
});

beforeEach(async () => {
  await env.db.deleteFrom("marketplaces").where("id", "<>", "official").execute();
  iconHits.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function addMarketplace(url: string): Promise<string> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/marketplaces",
    payload: { name: `M ${randomUUID().slice(0, 8)}`, url },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function refresh(id: string): Promise<void> {
  const r = await env.root({ method: "POST", url: `/api/v1/admin/marketplaces/${id}/refresh` });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().lastStatus).toBe("ok");
}
async function iconsOf(id: string): Promise<Map<string, string | null>> {
  const r = await env.root({
    method: "GET",
    url: `/api/v1/admin/marketplaces/entries?sourceId=${id}`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return new Map(
    (r.json().items as { name: string; icon: string | null }[]).map((e) => [e.name, e.icon]),
  );
}

describe("pure rules", () => {
  it("checkMarketplaceIcon keeps a real svg / png within the cap, by extension and content", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(checkMarketplaceIcon("/a/icon.svg", enc(SVG))).toMatchObject({
      contentType: "image/svg+xml",
    });
    expect(checkMarketplaceIcon("/a/icon.PNG", PNG)).toMatchObject({ contentType: "image/png" });
    expect(checkMarketplaceIcon("/a/icon.png", enc(SVG))).toMatch(/not a PNG/);
    expect(checkMarketplaceIcon("/a/icon.svg", enc("<html/>"))).toMatch(/not an SVG/);
    expect(checkMarketplaceIcon("/a/icon.gif", enc(SVG))).toMatch(/not a \.svg or \.png/);
    expect(checkMarketplaceIcon("/a/icon.svg", enc(BIG))).toMatch(/larger than/);
  });

  it("wantedIcons takes repository paths only from a git marketplace", () => {
    const es = [{ icon: "https://x.com/a.svg" }, { icon: "./p/a.svg" }, {}];
    expect(wantedIcons(es, "git")).toEqual({
      urls: new Set(["https://x.com/a.svg"]),
      paths: new Set(["./p/a.svg"]),
    });
    expect(wantedIcons(es, "http").paths.size).toBe(0);
  });

  it("gitIconPaths reads the manifest leniently, or a single plugin's plugin.json icon", () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const m = ".capybara-plugin/marketplace.json";
    const manifest = new Map([
      [m, enc({ plugins: [{ icon: "./a/i.svg" }, { icon: "https://x/i.svg" }, { icon: 1 }, {}] })],
    ]);
    expect(gitIconPaths(manifest, m, 1 << 20, 10)).toEqual(["a/i.svg"]);
    const solo = new Map([[".capybara-plugin/plugin.json", enc({ icon: "./icon.png" })]]);
    expect(gitIconPaths(solo, m, 1 << 20, 10)).toEqual(["icon.png"]);
    expect(gitIconPaths(new Map([[m, new TextEncoder().encode("{")]]), m, 1 << 20, 10)).toEqual([]);
  });
});

describe("marketplace entry icons", { timeout: 60_000 }, () => {
  it("URL icons are downloaded on refresh, stored and served; bad ones are skipped, the refresh still succeeds", async () => {
    market.setManifest({
      schemaVersion: 1,
      name: "Icons",
      plugins: [
        entry("ok-svg", `${iconBase}/icon.svg`),
        entry("ok-png", `${iconBase}/logo.png?v=1`),
        entry("too-big", `${iconBase}/big.svg`),
        entry("fake-png", `${iconBase}/fake.png`),
        entry("html-svg", `${iconBase}/page.svg`),
        entry("missing", `${iconBase}/missing.svg`),
        // a private address is refused by the network rules (never fetched)
        entry("private", "https://10.255.255.1/icon.svg"),
        // a repository path means nothing in a marketplace fetched over http
        entry("path", "./icons/x.svg"),
        entry("none"),
      ],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const got = await iconsOf(id);
    for (const name of ["too-big", "fake-png", "html-svg", "missing", "private", "path", "none"]) {
      expect(got.get(name), name).toBeNull();
    }
    const svgUrl = got.get("ok-svg") as string;
    expect(svgUrl).toMatch(new RegExp(`^/api/v1/admin/marketplaces/${id}/icons/[0-9a-f]{64}$`));
    const svg = await env.root({ method: "GET", url: svgUrl });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    expect(svg.headers["content-security-policy"]).toMatch(/^sandbox; default-src 'none'/);
    expect(svg.body).toBe(SVG);
    const png = await env.root({ method: "GET", url: got.get("ok-png") as string });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.rawPayload.equals(PNG)).toBe(true);
    // the private address never reached any server
    expect(iconHits.sort()).toEqual(
      ["/big.svg", "/fake.png", "/icon.svg", "/logo.png", "/missing.svg", "/page.svg"].sort(),
    );

    // An unchanged manifest (304) downloads nothing it already has; a URL counts as fixed
    iconHits.length = 0;
    await refresh(id);
    expect(iconHits.filter((p) => p === "/icon.svg" || p === "/logo.png")).toEqual([]);

    // An entry that drops its icon: the stored icon goes, its address is 404
    market.setManifest({
      schemaVersion: 1,
      name: "Icons",
      plugins: [entry("ok-svg"), entry("ok-png", `${iconBase}/logo.png?v=1`)],
    });
    await refresh(id);
    const after = await iconsOf(id);
    expect(after.get("ok-svg")).toBeNull();
    expect(after.get("ok-png")).toBe(got.get("ok-png"));
    expect((await env.root({ method: "GET", url: svgUrl })).statusCode).toBe(404);
    expect(
      await env.db
        .selectFrom("marketplace_icons")
        .select("ref")
        .where("source_id", "=", id)
        .execute(),
    ).toEqual([{ ref: `${iconBase}/logo.png?v=1` }]);
  });

  it("a git marketplace reads repository-path icons at the refreshed commit, a single-plugin repo its plugin.json icon", async () => {
    const manifest = (icon: string) => ({
      schemaVersion: 1,
      name: "Git icons",
      plugins: [
        { ...entry("gp"), icon },
        { ...entry("gp-missing"), icon: "./plugins/nope/icon.svg" },
        { ...entry("gp-bad"), icon: "./plugins/bad/icon.png" },
      ],
    });
    await git.commit("mkt-icons", {
      ".capybara-plugin/marketplace.json": JSON.stringify(manifest("./plugins/gp/icon.svg")),
      "plugins/gp/icon.svg": SVG,
      "plugins/bad/icon.png": "not a png",
    });
    const id = await addMarketplace(git.url("mkt-icons"));
    await refresh(id);
    const first = await iconsOf(id);
    expect(first.get("gp-missing")).toBeNull();
    expect(first.get("gp-bad")).toBeNull();
    const a = first.get("gp") as string;
    expect((await env.root({ method: "GET", url: a })).body).toBe(SVG);

    // A new commit with another icon at the same path: read again, a new address
    await git.commit("mkt-icons", {
      ".capybara-plugin/marketplace.json": JSON.stringify(manifest("./plugins/gp/icon.svg")),
      "plugins/gp/icon.svg": SVG2,
    });
    await refresh(id);
    const b = (await iconsOf(id)).get("gp") as string;
    expect(b).not.toBe(a);
    expect((await env.root({ method: "GET", url: b })).body).toBe(SVG2);

    await git.commit("solo-icon", {
      ".capybara-plugin/plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "solo-icon",
        version: "1.0.0",
        publisher: "Acme",
        description: "Solo",
        icon: "./assets/icon.svg",
      }),
      "assets/icon.svg": SVG,
      "skills/solo/SKILL.md": "---\nname: solo\ndescription: Solo skill\n---\nBody\n",
    });
    const solo = await addMarketplace(git.url("solo-icon"));
    await refresh(solo);
    const s = (await iconsOf(solo)).get("solo-icon") as string;
    expect(s).toMatch(/\/icons\/[0-9a-f]{64}$/);
    expect((await env.root({ method: "GET", url: s })).body).toBe(SVG);
  });

  it("an imported plugin shows its catalog icon, also on an entry of a newer version", async () => {
    market.setManifest({
      schemaVersion: 1,
      name: "Icons",
      plugins: [
        { ...entry("has-item", `${iconBase}/icon.svg`), version: "2.0.0" },
        entry("no-item", `${iconBase}/icon.svg`),
      ],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const itemId = randomUUID();
    await env.db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "has-item",
        package_name: "@acme/plugin-has-item",
        publisher: "Acme",
        description: "x",
        latest_version: "1.0.0",
      })
      .execute();
    await env.db
      .insertInto("catalog_item_versions")
      .values({
        item_id: itemId,
        version: "1.0.0",
        manifest: JSON.stringify({ name: "has-item", version: "1.0.0", icon: "./icon.svg" }),
        source: "file",
        source_ref: "upload",
        object_prefix: null,
        files: JSON.stringify([{ path: "icon.svg", size: SVG.length, sha256: "0".repeat(64) }]),
        size: 1,
      })
      .execute();
    try {
      const got = await iconsOf(id);
      expect(got.get("has-item")).toBe(`/api/v1/admin/catalog/items/${itemId}/icon?v=1.0.0`);
      expect(got.get("no-item")).toMatch(/\/api\/v1\/admin\/marketplaces\/.+\/icons\//);
    } finally {
      await env.db.deleteFrom("catalog_item_versions").where("item_id", "=", itemId).execute();
      await env.db.deleteFrom("catalog_items").where("id", "=", itemId).execute();
    }
  });

  it("only super admins reach the admin icon routes; org admins get theirs on the org browse", async () => {
    market.setManifest({
      schemaVersion: 1,
      name: "Icons",
      plugins: [entry("ok-svg", `${iconBase}/icon.svg`)],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const url = (await iconsOf(id)).get("ok-svg") as string;
    for (const req of [env.boss, env.mem]) {
      expect((await req({ method: "GET", url })).statusCode).toBe(403);
      expect(
        (await req({ method: "GET", url: "/api/v1/admin/marketplaces/entries" })).statusCode,
      ).toBe(403);
    }
    const org = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/marketplaces/entries?sourceId=${id}`,
    });
    expect(org.statusCode, org.body).toBe(200);
    const orgUrl = org.json().items[0].icon as string;
    const sha = url.split("/").pop() as string;
    expect(orgUrl).toBe(`/api/v1/orgs/${env.orgId}/marketplaces/${id}/icons/${sha}`);
    const got = await env.boss({ method: "GET", url: orgUrl });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/svg+xml");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toMatch(/^sandbox; default-src 'none'/);
    expect(got.body).toBe(SVG);
    // a member of the org: not an org admin
    expect((await env.mem({ method: "GET", url: orgUrl })).statusCode).toBe(403);
    // another org's route: the org admin is not in it
    const other = await createOrg(env.root, `Other ${randomUUID().slice(0, 6)}`);
    const otherUrl = orgUrl.replace(env.orgId, other);
    expect([403, 404]).toContain((await env.boss({ method: "GET", url: otherUrl })).statusCode);
    // a sha of another marketplace, or a disabled marketplace: not found
    expect(
      (await env.boss({ method: "GET", url: orgUrl.replace(sha, "f".repeat(64)) })).statusCode,
    ).toBe(404);
    const off = await env.root({
      method: "PATCH",
      url: `/api/v1/admin/marketplaces/${id}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await env.boss({ method: "GET", url: orgUrl })).statusCode).toBe(404);
    await env.root({
      method: "PATCH",
      url: `/api/v1/admin/marketplaces/${id}`,
      payload: { enabled: true },
    });
    // browsing off for orgs: 404 like the entries
    await setDeployment(env, { orgMarketplaceBrowse: false });
    try {
      expect((await env.boss({ method: "GET", url: orgUrl })).statusCode).toBe(404);
    } finally {
      await setDeployment(env, { orgMarketplaceBrowse: true });
    }
  });

  it("the org browse shows an imported item's org icon only when the org sees it (share gate)", async () => {
    market.setManifest({
      schemaVersion: 1,
      name: "Icons",
      plugins: [
        entry("seen-item", `${iconBase}/icon.svg`),
        entry("hidden-item", `${iconBase}/icon.svg`),
      ],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const items: Record<string, string> = {};
    for (const [name, scope] of [
      ["seen-item", "all"],
      ["hidden-item", "named"],
    ] as const) {
      const itemId = randomUUID();
      items[name] = itemId;
      await env.db
        .insertInto("catalog_items")
        .values({
          id: itemId,
          name,
          package_name: `@acme/plugin-${name}`,
          publisher: "Acme",
          description: "x",
          latest_version: "1.0.0",
          scope,
          // not shown to other orgs: unknown to an org outside the list
          shown_to_others: false,
        })
        .execute();
      await env.db
        .insertInto("catalog_item_versions")
        .values({
          item_id: itemId,
          version: "1.0.0",
          manifest: JSON.stringify({ name, version: "1.0.0", icon: "./icon.svg" }),
          source: "file",
          source_ref: "upload",
          object_prefix: null,
          files: JSON.stringify([{ path: "icon.svg", size: SVG.length, sha256: "0".repeat(64) }]),
          size: 1,
        })
        .execute();
    }
    try {
      const r = await env.boss({
        method: "GET",
        url: `/api/v1/orgs/${env.orgId}/marketplaces/entries?sourceId=${id}`,
      });
      expect(r.statusCode, r.body).toBe(200);
      const by = new Map(
        (r.json().items as { name: string; icon: string | null; adopted: unknown }[]).map((e) => [
          e.name,
          e,
        ]),
      );
      expect(by.get("seen-item")?.icon).toBe(
        `/api/v1/orgs/${env.orgId}/catalog/${items["seen-item"]}/icon?v=1.0.0`,
      );
      // the hidden item stays unknown: not imported, the marketplace's icon, never the item's
      expect(by.get("hidden-item")?.adopted).toBeNull();
      expect(by.get("hidden-item")?.icon).toMatch(
        new RegExp(`^/api/v1/orgs/${env.orgId}/marketplaces/${id}/icons/[0-9a-f]{64}$`),
      );
    } finally {
      for (const itemId of Object.values(items)) {
        await env.db.deleteFrom("catalog_item_versions").where("item_id", "=", itemId).execute();
        await env.db.deleteFrom("catalog_items").where("id", "=", itemId).execute();
      }
    }
  });

  it("an icon URL on a host outside marketplaces.allowedHosts is never fetched; a redirect is refused", async () => {
    const config = env.k.app.get(KernelConfigService);
    const real = config.get();
    vi.spyOn(config, "get").mockReturnValue({
      ...real,
      marketplaces: { ...real.marketplaces, allowedHosts: ["127.0.0.1"] },
    });
    const port = new URL(iconBase).port;
    market.setManifest({
      schemaVersion: 1,
      name: "Hosts",
      plugins: [
        // same server, another host name: refused before any request
        entry("other-host", `http://localhost:${port}/icon.svg`),
        // the server answers 302 to a valid icon: never followed
        entry("redirect", `${iconBase}/redirect.svg`),
      ],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const got = await iconsOf(id);
    expect(got.get("other-host")).toBeNull();
    expect(got.get("redirect")).toBeNull();
    expect(iconHits).toEqual(["/redirect.svg"]);
    expect(
      await env.db
        .selectFrom("marketplace_icons")
        .select("ref")
        .where("source_id", "=", id)
        .execute(),
    ).toEqual([]);
    // the redirect is a failed download (remembered); the refused host is not (no request made)
    expect(
      await env.db
        .selectFrom("marketplace_icon_failures")
        .select("ref")
        .where("source_id", "=", id)
        .execute(),
    ).toEqual([{ ref: `${iconBase}/redirect.svg` }]);
  });

  it("failed icon URLs back off; URLs never tried go first within the per-refresh cap", async () => {
    const broken = Array.from(
      { length: MARKETPLACE_ICON_FETCHES_MAX + 1 },
      (_, i) => `${iconBase}/broken/${String(i).padStart(3, "0")}.svg`,
    );
    const plugins = broken.map((url, i) => entry(`b${i}`, url));
    market.setManifest({ schemaVersion: 1, name: "Backoff", plugins });
    const id = await addMarketplace(market.url);
    await refresh(id);
    // the cap: one URL waits for the next refresh
    expect(iconHits).toHaveLength(MARKETPLACE_ICON_FETCHES_MAX);
    const failures = () =>
      env.db
        .selectFrom("marketplace_icon_failures")
        .select(["ref", "attempts"])
        .where("source_id", "=", id)
        .execute();
    expect(await failures()).toHaveLength(MARKETPLACE_ICON_FETCHES_MAX);
    const [left] = broken.filter((u) => !iconHits.includes(new URL(u).pathname));

    // the next refresh tries only the URL never tried; the failed ones are backing off
    iconHits.length = 0;
    await refresh(id);
    expect(iconHits).toEqual([new URL(left as string).pathname]);
    expect(await failures()).toHaveLength(MARKETPLACE_ICON_FETCHES_MAX + 1);

    // the backoff is over and a new icon appears: the new one first, then the oldest failures
    await env.db
      .updateTable("marketplace_icon_failures")
      .set({ failed_at: sql<Date>`now() - interval '7 hours'` as unknown as Date })
      .where("source_id", "=", id)
      .where("ref", "<>", left as string)
      .execute();
    market.setManifest({
      schemaVersion: 1,
      name: "Backoff",
      plugins: [...plugins, entry("fresh", `${iconBase}/icon.svg`)],
    });
    iconHits.length = 0;
    await refresh(id);
    expect(iconHits).toHaveLength(MARKETPLACE_ICON_FETCHES_MAX);
    expect(iconHits).toContain("/icon.svg");
    // the failure of the last refresh is not due yet
    expect(iconHits).not.toContain(new URL(left as string).pathname);
    expect((await iconsOf(id)).get("fresh")).toMatch(/\/icons\/[0-9a-f]{64}$/);
    const after = await failures();
    expect(after.filter((f) => f.attempts === 2)).toHaveLength(MARKETPLACE_ICON_FETCHES_MAX - 1);

    // an entry dropping its icon drops its failure too
    market.setManifest({ schemaVersion: 1, name: "Backoff", plugins: [entry("b0")] });
    await refresh(id);
    expect(await failures()).toEqual([]);
  });

  it("a failed icon write is recovered by the next refresh at the same commit", async () => {
    await git.commit("mkt-icons-retry", {
      ".capybara-plugin/marketplace.json": JSON.stringify({
        schemaVersion: 1,
        name: "Retry icons",
        plugins: [{ ...entry("rp"), icon: "./plugins/rp/icon.svg" }],
      }),
      "plugins/rp/icon.svg": SVG,
    });
    const id = await addMarketplace(git.url("mkt-icons-retry"));
    const svc = env.k.app.get(MarketplacesService) as unknown as {
      writeIcons: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(svc, "writeIcons").mockRejectedValueOnce(new Error("pg went away"));
    await refresh(id);
    expect((await iconsOf(id)).get("rp")).toBeNull();
    const row = () =>
      env.db
        .selectFrom("marketplaces")
        .select(["last_commit", "icons_commit"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    const first = await row();
    expect(first.last_commit).not.toBeNull();
    expect(first.icons_commit).toBeNull();

    // same commit: read again since its icons were never stored
    await refresh(id);
    const url = (await iconsOf(id)).get("rp") as string;
    expect(url).toMatch(/\/icons\/[0-9a-f]{64}$/);
    expect((await env.root({ method: "GET", url })).body).toBe(SVG);
    expect(await row()).toEqual({
      last_commit: first.last_commit,
      icons_commit: first.last_commit,
    });
  });

  it("a stored marketplace icon is checked again on read", async () => {
    market.setManifest({
      schemaVersion: 1,
      name: "Tamper",
      plugins: [entry("t", `${iconBase}/icon.svg`)],
    });
    const id = await addMarketplace(market.url);
    await refresh(id);
    const url = (await iconsOf(id)).get("t") as string;
    expect((await env.root({ method: "GET", url })).statusCode).toBe(200);
    // other bytes under the recorded sha256: refused
    await env.db
      .updateTable("marketplace_icons")
      .set({ data: Buffer.from(SVG2) })
      .where("source_id", "=", id)
      .execute();
    expect((await env.root({ method: "GET", url })).statusCode).toBe(500);
    // not an svg at all
    await env.db
      .updateTable("marketplace_icons")
      .set({ data: Buffer.from("<html><script>1</script></html>") })
      .where("source_id", "=", id)
      .execute();
    expect((await env.root({ method: "GET", url })).statusCode).toBe(500);
  });
});
