import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmPending,
  confirmPluginImport,
  decideDeploymentRequest,
  decideOrgRequest,
  listMarketplaceEntries,
  listOrgMarketplaceEntries,
  listPendingPlugins,
  previewScope,
  requestCatalogItem,
  requestMarketplaceEntry,
  setDisabled,
  setOrgPluginSwitch,
  setScope,
  setShownToOthers,
} from "../src/lib/catalog";
import { putOrgExtension } from "../src/lib/extensions";
import { pendingPluginsQuery } from "../src/lib/query/admin";
import { orgMarketplaceEntriesQuery, pluginScopeChangeKeys } from "../src/lib/query/catalog";
import { keys } from "../src/lib/query/keys";
import { bodyOf, json, stubApi } from "./support/api";

afterEach(() => vi.unstubAllGlobals());

const ORG = "o1";
const ok = () => json(200, {});

describe("plugin scope data layer: loaders call the kernel routes with the given bodies", () => {
  it("org switch: on with inputs, off preview then confirm", async () => {
    const calls = stubApi({ [`PUT /api/v1/orgs/${ORG}/catalog/i1/switch`]: ok });
    await setOrgPluginSwitch(ORG, "i1", {
      enabled: true,
      inputs: { extensionConfig: { region: "eu" } },
    });
    await setOrgPluginSwitch(ORG, "i1", { enabled: false });
    await setOrgPluginSwitch(ORG, "i1", { enabled: false, confirm: "h" });
    expect(calls.map((c) => bodyOf(c))).toEqual([
      { enabled: true, inputs: { extensionConfig: { region: "eu" } } },
      { enabled: false },
      { enabled: false, confirm: "h" },
    ]);
  });

  it("admin scope: preview, set, disabled, shown, pending, confirm", async () => {
    const a = "/api/v1/admin/catalog/items/i1";
    const calls = stubApi({
      [`POST ${a}/scope/preview`]: () =>
        json(200, { affected: [], needsConfig: [], scopeHash: "s" }),
      [`PUT ${a}/scope`]: ok,
      [`PUT ${a}/disabled`]: ok,
      [`PUT ${a}/shown`]: ok,
      [`POST ${a}/confirm`]: ok,
      "GET /api/v1/admin/catalog/items?pending=true": () =>
        json(200, { items: [], nextOffset: null }),
    });
    const p = await previewScope("i1", { scope: "named", orgs: ["o1"] });
    expect(p.scopeHash).toBe("s");
    await previewScope("i1", { disabled: true });
    await setScope("i1", { scope: "named", orgs: ["o1"], scopeHash: "s" });
    await setDisabled("i1", { disabled: true, scopeHash: "s" });
    await setShownToOthers("i1", false);
    await confirmPending("i1", { permissionsHash: "p" });
    await listPendingPlugins();
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(bodyOf(c) ?? null)}`)).toEqual([
      `POST ${a}/scope/preview {"scope":"named","orgs":["o1"]}`,
      `POST ${a}/scope/preview {"disabled":true}`,
      `PUT ${a}/scope {"scope":"named","orgs":["o1"],"scopeHash":"s"}`,
      `PUT ${a}/disabled {"disabled":true,"scopeHash":"s"}`,
      `PUT ${a}/shown {"shownToOthers":false}`,
      `POST ${a}/confirm {"permissionsHash":"p"}`,
      "GET /api/v1/admin/catalog/items?pending=true null",
    ]);
  });

  it("import confirm sends scope and orgs, never deployExtension", async () => {
    const calls = stubApi({ "POST /api/v1/admin/catalog/imports/s1/confirm": ok });
    await confirmPluginImport("s1", { reviewHash: "h", scope: "named", orgs: ["o1"] });
    expect(bodyOf(calls[0])).toEqual({ reviewHash: "h", scope: "named", orgs: ["o1"] });
  });

  it("requests: kinds, decide with { approve, reason }, marketplace entries", async () => {
    const o = `/api/v1/orgs/${ORG}`;
    const calls = stubApi({
      [`POST ${o}/catalog/i1/requests`]: ok,
      [`POST ${o}/marketplace-requests`]: ok,
      [`POST ${o}/catalog-requests/r1/decide`]: ok,
      "POST /api/v1/admin/catalog/requests/r2/decide": ok,
      [`GET ${o}/marketplaces/entries?q=x`]: () => json(200, { items: [], truncated: false }),
      "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [] }),
    });
    await requestCatalogItem(ORG, "i1", "enable", "please");
    await requestCatalogItem(ORG, "i1", "access", "");
    await requestMarketplaceEntry(
      ORG,
      { marketplaceId: "official", name: "p", version: "1.0.0" },
      "n",
    );
    await decideOrgRequest(ORG, "r1", { approve: false, reason: "no" });
    await decideDeploymentRequest("r2", { approve: true });
    await listOrgMarketplaceEntries(ORG, { q: "x" });
    await listMarketplaceEntries();
    expect(calls.slice(0, 5).map((c) => bodyOf(c))).toEqual([
      { kind: "enable", note: "please" },
      { kind: "access" },
      { marketplaceId: "official", name: "p", version: "1.0.0", note: "n" },
      { approve: false, reason: "no" },
      { approve: true },
    ]);
  });

  it("org extension put may answer the switch preview", async () => {
    stubApi({
      [`PUT /api/v1/orgs/${ORG}/extensions/x`]: () =>
        json(200, { preview: { installId: "i" }, confirm: "c" }),
    });
    const r = await putOrgExtension(ORG, "x", { enabled: false });
    expect("preview" in r && r.confirm).toBe("c");
  });
});

describe("plugin scope queries and keys", () => {
  it("pending plugins live under the deployment prefix", () => {
    expect(keys.deployment().catalogPending()).toEqual([
      ...(keys.deployment().catalog() as unknown[]).slice(0, -1),
      "catalogPending",
    ]);
    expect(pendingPluginsQuery().queryKey).toEqual(keys.deployment().catalogPending());
  });

  it("org marketplace entries key starts with the org prefix", () => {
    expect(orgMarketplaceEntriesQuery(ORG, "", "").queryKey.slice(0, 2)).toEqual(["org", ORG]);
  });

  it("a scope or switch change invalidates org and deployment catalog and extension keys", () => {
    const changed = pluginScopeChangeKeys(ORG);
    for (const k of [
      keys.org(ORG).catalog(),
      keys.org(ORG).catalogItemsAll(),
      keys.org(ORG).orgExtensions(),
      keys.deployment().catalog(),
      keys.deployment().catalogItemsAll(),
      keys.deployment().extensions(),
      keys.deployment().catalogPending(),
    ]) {
      expect(changed).toContainEqual(k);
    }
  });
});
