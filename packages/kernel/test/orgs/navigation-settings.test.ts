import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The org's navigation setting (plugin full pages spec §9): where plugin pages sit, at most 3 in
 * the primary navigation, edited by org admins only.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let orgId: string;
let owner: Req;
let admin: Req;
let member: Req;

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;
const page = (n: number, section: "primary" | "more") => ({
  contribution: `plug-${n}/page`,
  section,
});

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }), {
    env: {},
  });
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "admin", "member"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  owner = await session(k, "owner");
  admin = await session(k, "admin");
  member = await session(k, "member");
  orgId = await createOrg(owner);
  const members = testMembers(db);
  await members.add(orgId, ids.admin as string, "admin", ids.owner as string);
  await members.add(orgId, ids.member as string, "member", ids.owner as string);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const url = () => `/api/v1/orgs/${orgId}/settings`;
const patch = (req: Req, navigation: unknown) =>
  req({ method: "PATCH", url: url(), payload: { navigation } });
const read = async (req: Req) =>
  (await req({ method: "GET", url: url() })).json() as {
    settings: { navigation?: { pluginPages: unknown[] } };
  };

describe("navigation setting", () => {
  it("absent until an admin saves; an admin saves and clears it", async () => {
    expect((await read(owner)).settings.navigation).toBeUndefined();
    const pluginPages = [page(1, "primary"), page(2, "more")];
    const saved = await patch(admin, { pluginPages });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read(member)).settings.navigation).toEqual({ pluginPages });
    const cleared = await patch(admin, null);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await read(owner)).settings.navigation).toBeUndefined();
  });

  it("allows three primary pages and refuses a fourth", async () => {
    const three = await patch(owner, {
      pluginPages: [page(1, "primary"), page(2, "primary"), page(3, "primary"), page(4, "more")],
    });
    expect(three.statusCode, three.body).toBe(200);
    const four = await patch(owner, {
      pluginPages: [1, 2, 3, 4].map((n) => page(n, "primary")),
    });
    expect(four.statusCode, four.body).toBe(400);
    expect(errCode(four)).toBe("org_settings.nav_primary_limit");
    // the refused save changed nothing
    expect((await read(owner)).settings.navigation?.pluginPages).toHaveLength(4);
    await patch(owner, null);
  });

  it("refuses a malformed key, an unknown section and a duplicate", async () => {
    for (const pluginPages of [
      [{ contribution: "no-slash", section: "primary" }],
      [{ contribution: "plug-1/page", section: "top" }],
      [page(1, "primary"), page(1, "more")],
    ]) {
      const r = await patch(owner, { pluginPages });
      expect(r.statusCode, r.body).toBe(400);
      expect(errCode(r)).toBe("validation_failed");
    }
  });

  it("a member cannot edit it", async () => {
    const r = await patch(member, { pluginPages: [page(1, "primary")] });
    expect(r.statusCode, r.body).toBe(403);
    expect((await read(owner)).settings.navigation).toBeUndefined();
  });

  it("an invalid stored value reads as absent, and a save keeps the other settings", async () => {
    await db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ locale: "zh", navigation: "junk" }) })
      .where("id", "=", orgId)
      .execute();
    expect((await read(owner)).settings.navigation).toBeUndefined();
    const pluginPages = [page(1, "primary")];
    const saved = await patch(owner, { pluginPages });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = (await read(owner)).settings as { locale?: string; navigation?: unknown };
    expect(after.navigation).toEqual({ pluginPages });
    expect(after.locale).toBe("zh");
  });

  it("an unchanged save writes nothing new", async () => {
    const pluginPages = [page(2, "more")];
    await patch(owner, { pluginPages });
    const again = await patch(owner, { pluginPages });
    expect(again.statusCode, again.body).toBe(200);
    expect((await read(owner)).settings.navigation).toEqual({ pluginPages });
  });
});
