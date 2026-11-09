import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { resolveSingleSlot, type UiArrangementEntry } from "../../src/ui/arrangement.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The winner of a single slot (client extensions spec §6.3): the org's `use` if it has an entry,
 * else the platform's, else the built-in; a `use` naming a contribution not available in the org is
 * the built-in, never the other level's pick. `use` decides only what is listed.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let orgId: string;
let ui: string;
let owner: Req;
let admin: Req;
let member: Req;
let root: Req;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

const A = "ui-components/brand";
const B = "ui-components-b/brand";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] });
  k = await startKernel(
    {
      ...base,
      extensions: [...base.extensions, fixture("ui-components"), fixture("ui-components-b")],
    },
    { env: {} },
  );
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "admin", "member"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true });
  owner = await session(k, "owner");
  admin = await session(k, "admin");
  member = await session(k, "member");
  root = await session(k, "root");
  orgId = await createOrg(owner);
  const members = testMembers(db);
  await members.add(orgId, ids.admin as string, "admin", ids.owner as string);
  await members.add(orgId, ids.member as string, "member", ids.owner as string);
  await enableExtensions(raw, orgId, "ui-components", "ui-components-b");
  ui = `/api/v1/orgs/${orgId}/ui`;
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Item = { plugin: string; id: string };
const brand = async (req: Req = member): Promise<string[]> => {
  const r = await req({ method: "GET", url: `${ui}/contributions?slot=shell.brand` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items.map((i) => `${i.plugin}/${i.id}`);
};
const patchOrg = (uiArrangement: Record<string, unknown>) =>
  admin({ method: "PATCH", url: `/api/v1/orgs/${orgId}/settings`, payload: { uiArrangement } });
const putPlatform = (uiArrangement: Record<string, unknown>) =>
  root({ method: "PUT", url: "/api/v1/admin/settings", payload: { uiArrangement } });
type SingleSlot = {
  slot: string;
  candidates: { key: string; title: { zh: string; en: string } }[];
  use: string | null;
  followsPlatform: boolean;
};
const brandSlot = async (req: Req = member, base = ui): Promise<SingleSlot> => {
  const r = await req({ method: "GET", url: `${base}/arrangement` });
  expect(r.statusCode, r.body).toBe(200);
  const slots = (r.json() as { slots: (SingleSlot & { items?: unknown })[] }).slots;
  const s = slots.find((x) => x.slot === "shell.brand");
  expect(s).toBeDefined();
  expect(s).not.toHaveProperty("items");
  return s as SingleSlot;
};
const setEnabled = (plugin: string, enabled: boolean) =>
  owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled },
  });

beforeEach(async () => {
  expect((await patchOrg({ "shell.brand": null })).statusCode).toBe(200);
  expect((await putPlatform({ "shell.brand": null })).statusCode).toBe(200);
});

describe("use on single slots", () => {
  it("the org use picks the winner", async () => {
    expect(await brand()).toEqual([]);
    const r = await patchOrg({ "shell.brand": { use: B } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await brand()).toEqual([B]);
    const s = await brandSlot();
    expect(s.candidates.map((c) => c.key)).toEqual([A, B]);
    expect(s.candidates[1]?.title).toEqual({ zh: "品牌 B", en: "Brand B" });
    expect(s.use).toBe(B);
    expect(s.followsPlatform).toBe(false);
    // only the listing follows the winner: the loser's server view is still served
    const v = await member({ method: "GET", url: `${ui}/views/ui-components/brand` });
    expect(v.statusCode, v.body).toBe(200);
    expect((v.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 3 });
  });

  it("the platform use is the default and the org entry replaces it", async () => {
    expect((await putPlatform({ "shell.brand": { use: A } })).statusCode).toBe(200);
    expect(await brand()).toEqual([A]);
    let s = await brandSlot();
    expect(s.use).toBe(A);
    expect(s.followsPlatform).toBe(true);
    expect((await patchOrg({ "shell.brand": { use: B } })).statusCode).toBe(200);
    expect(await brand()).toEqual([B]);
    expect((await brandSlot()).followsPlatform).toBe(false);
    // null removes the org's entry: the platform's pick applies again
    expect((await patchOrg({ "shell.brand": null })).statusCode).toBe(200);
    expect(await brand()).toEqual([A]);
    // the platform's own listing: every running candidate and its pick
    s = await brandSlot(root, "/api/v1/admin/ui");
    expect(s.candidates.map((c) => c.key)).toEqual([A, B]);
    expect(s.use).toBe(A);
    expect(s.followsPlatform).toBe(false);
  });

  it("use null is the built-in even when the platform picked one", async () => {
    await putPlatform({ "shell.brand": { use: A } });
    expect((await patchOrg({ "shell.brand": { use: null } })).statusCode).toBe(200);
    expect(await brand()).toEqual([]);
    const s = await brandSlot();
    expect(s.use).toBeNull();
    expect(s.followsPlatform).toBe(false);
  });

  it("an unavailable use key resolves to the built-in, not the platform's choice", async () => {
    await putPlatform({ "shell.brand": { use: A } });
    await patchOrg({ "shell.brand": { use: B } });
    expect((await setEnabled("ui-components-b", false)).statusCode).toBe(200);
    try {
      expect(await brand()).toEqual([]);
      const s = await brandSlot();
      // the stored key is kept (the extension may come back); it is no longer a candidate
      expect(s.use).toBe(B);
      expect(s.candidates.map((c) => c.key)).toEqual([A]);
      // the platform's pick being unavailable in the org is the built-in too
      await patchOrg({ "shell.brand": null });
      await putPlatform({ "shell.brand": { use: B } });
      expect(await brand()).toEqual([]);
    } finally {
      expect((await setEnabled("ui-components-b", true)).statusCode).toBe(200);
    }
    expect(await brand()).toEqual([B]);
  });

  it("use on a list slot and hidden on a single slot are 400", async () => {
    const bad: Record<string, unknown>[] = [
      { "org.page": { use: null } },
      { "shell.overlay": { use: "ui-components/fx" } },
      { "shell.brand": { hidden: [], order: [] } },
      { "shell.brand": { use: A, hidden: [] } },
      { "shell.brand": { use: "Not A Key" } },
      { "shell.brand": {} },
    ];
    for (const entry of bad) {
      const o = await patchOrg(entry);
      expect(o.statusCode, `${JSON.stringify(entry)} ${o.body}`).toBe(400);
      expect(errCode(o)).toBe("validation_failed");
      const p = await putPlatform(entry);
      expect(p.statusCode, `${JSON.stringify(entry)} ${p.body}`).toBe(400);
      expect(errCode(p)).toBe("validation_failed");
    }
    // the list slots keep hidden / order
    expect((await patchOrg({ "shell.overlay": { hidden: [], order: [] } })).statusCode).toBe(200);
    expect((await patchOrg({ "shell.overlay": null })).statusCode).toBe(200);
  });
});

describe("resolveSingleSlot table", () => {
  const avail = new Set([A, B]);
  const use = (u: string | null): UiArrangementEntry => ({ use: u });
  const rows: [
    string,
    UiArrangementEntry | undefined,
    UiArrangementEntry | undefined,
    string | null,
  ][] = [
    ["no entry anywhere: the built-in", undefined, undefined, null],
    ["the org's pick", use(B), undefined, B],
    ["the platform's pick when the org has no entry", undefined, use(A), A],
    ["the org's pick over the platform's", use(B), use(A), B],
    ["org null over a platform pick: the built-in", use(null), use(A), null],
    [
      "an unavailable org pick: the built-in, not the platform's",
      use("x-gone/brand"),
      use(A),
      null,
    ],
    ["an unavailable platform pick: the built-in", undefined, use("x-gone/brand"), null],
    ["a list entry on a single slot reads as none", { hidden: [], order: [] }, use(A), null],
  ];
  it.each(rows)("%s", (_name, org, platform, want) => {
    expect(resolveSingleSlot("shell.brand", org, platform, avail)).toBe(want);
  });

  it("a list slot has no winner", () => {
    expect(resolveSingleSlot("org.page", use(A), undefined, avail)).toBeNull();
  });
});
