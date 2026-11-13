import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
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
 * UI slots arrangement (spec §5): an org's and the platform's hidden / order entries apply to the
 * contribution lists only; hidden means not listed, never not served.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

let orgId: string;
let otherOrgId: string;
let ui: string;
let owner: Req;
let admin: Req;
let member: Req;
let guest: Req;
let root: Req;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    {
      ...base,
      extensions: [...base.extensions, fixture("ui-slots")],
    },
    { env: {} },
  );
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "admin", "member", "guest"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  ids.root = (
    await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true })
  ).id;
  owner = await session(k, "owner");
  admin = await session(k, "admin");
  member = await session(k, "member");
  guest = await session(k, "guest");
  root = await session(k, "root");
  orgId = await createOrg(owner);
  otherOrgId = await createOrg(owner, "Other");
  const members = testMembers(db);
  await members.add(orgId, ids.admin as string, "admin", ids.owner as string);
  await members.add(orgId, ids.member as string, "member", ids.owner as string);
  await members.add(orgId, ids.guest as string, "guest", ids.owner as string);
  await members.add(orgId, ids.root as string, "member", ids.owner as string);
  await members.add(otherOrgId, ids.admin as string, "member", ids.owner as string);
  await enableExtensions(raw, orgId, "ui-slots");
  await enableExtensions(raw, otherOrgId, "ui-slots");
  ui = `/api/v1/orgs/${orgId}/ui`;
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Item = { plugin: string; id: string; slot: string; hidden?: boolean };
const keys = (items: Item[]) => items.map((i) => `${i.plugin}/${i.id}`);
const list = async (req: Req, query = "", base = ui): Promise<Item[]> => {
  const r = await req({ method: "GET", url: `${base}/contributions${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items;
};
const patchOrg = (req: Req, uiArrangement: Record<string, unknown>, org = orgId) =>
  req({ method: "PATCH", url: `/api/v1/orgs/${org}/settings`, payload: { uiArrangement } });
const putPlatform = (uiArrangement: Record<string, unknown>) =>
  root({ method: "PUT", url: "/api/v1/admin/settings", payload: { uiArrangement } });
const arrangement = async (req: Req, base = ui) => {
  const r = await req({ method: "GET", url: `${base}/arrangement` });
  expect(r.statusCode, r.body).toBe(200);
  return (
    r.json() as { slots: { slot: string; source: string; items: (Item & { hidden: boolean })[] }[] }
  ).slots;
};
const PAGE = "ui-slots/page";

beforeEach(async () => {
  for (const o of [orgId, otherOrgId]) {
    await patchOrg(owner, { "org.page": null, "agent.detail.section": null }, o);
  }
  await putPlatform({
    "org.page": null,
    "agent.detail.section": null,
    "platform.page": null,
  });
});

describe("arrangement", () => {
  it("PATCH settings uiArrangement hides an org page from the list", async () => {
    const r = await patchOrg(admin, { "org.page": { hidden: [PAGE], order: [] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(keys(await list(member))).not.toContain(PAGE);
    expect(keys(await list(member))).toContain("ui-slots/page-embed");
    expect(keys(await list(member, "?slot=org.page"))).toEqual(["ui-slots/page-embed"]);
  });

  it("a hidden org page still renders by direct URL", async () => {
    await patchOrg(admin, { "org.page": { hidden: [PAGE], order: [] } });
    expect(keys(await list(member, "?slot=org.page"))).not.toContain(PAGE);
    const r = await member({ method: "GET", url: `${ui}/views/${PAGE}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (await member({ method: "POST", url: `${ui}/actions/${PAGE}`, payload: { actionId: "go" } }))
        .statusCode,
    ).toBe(200);
    // the guest's refusal is the slot's, not the arrangement's
    expect((await guest({ method: "GET", url: `${ui}/views/${PAGE}` })).statusCode).toBe(404);
  });

  it("a hidden platform page still renders by direct URL", async () => {
    expect(
      (await putPlatform({ "platform.page": { hidden: ["ui-slots/platform-home"], order: [] } }))
        .statusCode,
    ).toBe(200);
    expect(keys(await list(root, "", "/api/v1/admin/ui"))).not.toContain("ui-slots/platform-home");
    const r = await root({ method: "GET", url: "/api/v1/admin/ui/views/ui-slots/platform-home" });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("the org arrangement refuses platform.page and file.preview", async () => {
    for (const slot of ["platform.page", "file.preview"]) {
      const r = await patchOrg(admin, { [slot]: { hidden: [], order: [] } });
      expect(r.statusCode, r.body).toBe(400);
      expect(errCode(r)).toBe("validation_failed");
    }
    const bad = await patchOrg(admin, { "org.page": { hidden: ["NotAKey"], order: [] } });
    expect(bad.statusCode).toBe(400);
    // a member cannot write it
    expect((await patchOrg(member, { "org.page": { hidden: [], order: [] } })).statusCode).toBe(
      403,
    );
  });

  it("null removes an org entry and the platform default applies", async () => {
    await putPlatform({ "org.page": { hidden: [PAGE], order: [] } });
    expect(keys(await list(member, "?slot=org.page"))).toEqual(["ui-slots/page-embed"]);
    // the org's own entry replaces the platform's for that slot
    await patchOrg(admin, { "org.page": { hidden: [], order: ["ui-slots/page-embed"] } });
    expect(keys(await list(member, "?slot=org.page"))).toEqual(["ui-slots/page-embed", PAGE]);
    expect((await arrangement(member)).find((s) => s.slot === "org.page")?.source).toBe("org");
    await patchOrg(admin, { "org.page": null });
    expect(keys(await list(member, "?slot=org.page"))).toEqual(["ui-slots/page-embed"]);
    expect((await arrangement(member)).find((s) => s.slot === "org.page")?.source).toBe("platform");
  });

  it("the platform default orders platform pages", async () => {
    const base = "/api/v1/admin/ui";
    expect(keys(await list(root, "", base))).toEqual([
      "ui-slots/platform-home",
      "ui-slots/platform-embed",
    ]);
    const r = await putPlatform({
      "platform.page": { hidden: [], order: ["ui-slots/platform-embed"] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(keys(await list(root, "", base))).toEqual([
      "ui-slots/platform-embed",
      "ui-slots/platform-home",
    ]);
    const slots = await arrangement(root, base);
    const pp = slots.find((s) => s.slot === "platform.page");
    expect(pp?.source).toBe("platform");
    expect(pp?.items.map((i) => i.hidden)).toEqual([false, false]);
    expect(slots.some((s) => s.slot === "file.preview")).toBe(false);
  });

  it("another org is unaffected", async () => {
    await patchOrg(admin, { "org.page": { hidden: [PAGE], order: [] } });
    expect(keys(await list(owner, "?slot=org.page"))).not.toContain(PAGE);
    const other = await admin({
      method: "GET",
      url: `/api/v1/orgs/${otherOrgId}/ui/contributions?slot=org.page`,
    });
    expect(keys((other.json() as { items: Item[] }).items)).toContain(PAGE);
  });

  it("a member reads the arrangement, a guest gets 404", async () => {
    await patchOrg(admin, { "org.page": { hidden: [PAGE], order: [] } });
    const slots = await arrangement(member);
    expect(slots.map((s) => s.slot)).not.toContain("platform.page");
    expect(slots.map((s) => s.slot)).not.toContain("file.preview");
    const orgPage = slots.find((s) => s.slot === "org.page");
    expect(orgPage?.source).toBe("org");
    // the hidden one is in place, marked
    expect(orgPage?.items.map((i) => [`${i.plugin}/${i.id}`, i.hidden])).toEqual([
      [PAGE, true],
      ["ui-slots/page-embed", false],
    ]);
    // the caller's role filters: only an admin sees org.settings.section
    expect(slots.find((s) => s.slot === "org.settings.section")?.items).toEqual([]);
    expect(
      (await arrangement(admin)).find((s) => s.slot === "org.settings.section")?.items,
    ).toHaveLength(1);
    const g = await guest({ method: "GET", url: `${ui}/arrangement` });
    expect(g.statusCode, g.body).toBe(404);
    expect(errCode(g)).toBe("ui.not_found");
  });

  it("an invalid stored value reads as absent", async () => {
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ uiArrangement: { "org.page": "junk" } }) })
      .where("id", "=", orgId)
      .execute();
    expect(keys(await list(member, "?slot=org.page"))).toContain(PAGE);
    const s = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
    expect(s.statusCode, s.body).toBe(200);
    expect(
      (s.json() as { settings: Record<string, unknown> }).settings.uiArrangement,
    ).toBeUndefined();
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({}) })
      .where("id", "=", orgId)
      .execute();
  });
  it("a scheduledTasks patch round-trips through the org settings route", async () => {
    const url = `/api/v1/orgs/${orgId}/settings`;
    const p = await admin({
      method: "PATCH",
      url,
      payload: { scheduledTasks: { minIntervalMinutes: 15, forbiddenTools: ["Bash"] } },
    });
    expect(p.statusCode, p.body).toBe(200);
    const g = await admin({ method: "GET", url });
    const st = (g.json() as { settings: { scheduledTasks: Record<string, unknown> } }).settings
      .scheduledTasks;
    expect(st).toMatchObject({
      minIntervalMinutes: 15,
      forbiddenTools: ["Bash"],
      maxTasksPerOrg: 200,
      enabled: true,
    });
    const bad = await admin({ method: "PATCH", url, payload: { scheduledTasks: { enabled: 1 } } });
    expect(bad.statusCode).toBe(400);
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({}) })
      .where("id", "=", orgId)
      .execute();
  });
});
