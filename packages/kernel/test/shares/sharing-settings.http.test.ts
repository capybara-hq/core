import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { createLogger } from "../../src/log.js";
import { HTML_CDN_ALLOWLIST_DEFAULT } from "../../src/shares/settings.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { createOrg, PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accounts: AccountsService;
let tokens: ApiTokenService;

const rawConfig = (over: Record<string, unknown> = {}) => ({
  db: { url: pgc.url, poolMax: 5 },
  redis: { url: rd.url },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  marketplaces: { official: { enabled: false } },
  http: { port: 0 },
  ...over,
});
const config = (): KernelConfig => KernelConfigSchema.parse(rawConfig());

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(config(), { logger: createLogger("error", { write: () => {} }) });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  accounts = accountsFor(db);
  tokens = apiTokensFor(db);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let adminId: string;
let adminReq: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events",
  );
  const admin = await accounts.createLocal({
    login: "admin",
    password: PW,
    displayName: "Admin",
    superAdmin: true,
  });
  adminId = admin.id;
  adminReq = await session(k, "admin");
  orgId = await createOrg(adminReq);
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const viaToken = async () => {
  const pat = await tokens.createPersonal(adminId, { name: "automation" });
  return (method: "PUT" | "PATCH", url: string, payload: Record<string, unknown>) =>
    k.http.inject({ method, url, headers: { authorization: `Bearer ${pat.token}` }, payload });
};

const putSettings = (payload: Record<string, unknown>) =>
  adminReq({ method: "PUT", url: "/api/v1/admin/settings", payload });
const patchOrg = (payload: Record<string, unknown>) =>
  adminReq({ method: "PATCH", url: `/api/v1/orgs/${orgId}/settings`, payload });

describe("platform sharing settings", () => {
  it("the defaults: external sharing denied, 30 days, the five CDNs", async () => {
    const res = await adminReq({ method: "GET", url: "/api/v1/admin/settings" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      externalSharing: { value: "deny", source: "default" },
      shareMaxExpiryDays: { value: 30, source: "default" },
      htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT],
    });
  });

  it("a person saves the values; null goes back to the defaults; the allowlist is replaced whole", async () => {
    const saved = await putSettings({
      externalSharing: "allow",
      shareMaxExpiryDays: 7,
      htmlRenderCdnAllowlist: ["HTTPS://CDN.Example.com", "https://cdn.example.com:8443"],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      externalSharing: { value: "allow", source: "db" },
      shareMaxExpiryDays: { value: 7, source: "db" },
      htmlRenderCdnAllowlist: ["https://cdn.example.com", "https://cdn.example.com:8443"],
    });
    const cleared = await putSettings({ externalSharing: null, shareMaxExpiryDays: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({
      externalSharing: { value: "deny", source: "default" },
      shareMaxExpiryDays: { value: 30, source: "default" },
    });
  });

  it("refuses an invalid allowlist entry or expiry", async () => {
    for (const payload of [
      { htmlRenderCdnAllowlist: ["http://x.com"] },
      { htmlRenderCdnAllowlist: ["https://x.com/lib.js"] },
      { shareMaxExpiryDays: 0 },
      { shareMaxExpiryDays: 366 },
      { externalSharing: "on" },
    ]) {
      const res = await putSettings(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("an API token may turn external sharing off, never on", async () => {
    const req = await viaToken();
    const widened = await req("PUT", "/api/v1/admin/settings", { externalSharing: "allow" });
    expect(widened.statusCode, widened.body).toBe(400);
    expect(errCode(widened)).toBe("deployment.external_sharing_not_allowed");
    const off = await req("PUT", "/api/v1/admin/settings", { externalSharing: "deny" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().externalSharing).toEqual({ value: "deny", source: "db" });
    // once a person allowed it, the token may keep it allowed (no widening) or turn it off
    expect((await putSettings({ externalSharing: "allow" })).statusCode).toBe(200);
    const kept = await req("PUT", "/api/v1/admin/settings", { externalSharing: "allow" });
    expect(kept.statusCode, kept.body).toBe(200);
    const cleared = await req("PUT", "/api/v1/admin/settings", { externalSharing: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().externalSharing).toEqual({ value: "deny", source: "default" });
  });

  it("an API token may only lower the expiry maximum and remove CDN origins", async () => {
    const req = await viaToken();
    const put = (payload: Record<string, unknown>) => req("PUT", "/api/v1/admin/settings", payload);
    // the expiry maximum: raising it (from the default 30) is refused, lowering it is fine
    const raised = await put({ shareMaxExpiryDays: 365 });
    expect(raised.statusCode, raised.body).toBe(400);
    expect(errCode(raised)).toBe("deployment.sharing_widen_not_allowed");
    const lowered = await put({ shareMaxExpiryDays: 7 });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(lowered.json().shareMaxExpiryDays).toEqual({ value: 7, source: "db" });
    // clearing from 7 goes back to 30: a widening
    const cleared = await put({ shareMaxExpiryDays: null });
    expect(cleared.statusCode, cleared.body).toBe(400);
    expect(errCode(cleared)).toBe("deployment.sharing_widen_not_allowed");
    expect((await put({ shareMaxExpiryDays: 8 })).statusCode).toBe(400);
    expect((await put({ shareMaxExpiryDays: 7 })).statusCode).toBe(200);

    // the allowlist: adding an origin is refused (even next to a removal), removing one is fine
    const added = await put({
      htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT, "https://attacker.example"],
    });
    expect(added.statusCode, added.body).toBe(400);
    expect(errCode(added)).toBe("deployment.sharing_widen_not_allowed");
    const swapped = await put({ htmlRenderCdnAllowlist: ["https://attacker.example"] });
    expect(swapped.statusCode, swapped.body).toBe(400);
    const shrunk = HTML_CDN_ALLOWLIST_DEFAULT.slice(1);
    // upper case and duplicates compare as the same origins
    const removed = await put({
      htmlRenderCdnAllowlist: [...shrunk.map((o) => o.toUpperCase()), shrunk[0]],
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().htmlRenderCdnAllowlist).toEqual(shrunk);
    // the dropped origin cannot come back through the token, but a person adds it
    const back = await put({ htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT] });
    expect(back.statusCode, back.body).toBe(400);
    const person = await putSettings({
      htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT],
      shareMaxExpiryDays: 365,
    });
    expect(person.statusCode, person.body).toBe(200);
  });

  it("an invalid stored value reads as deny / 30 days / the default allowlist (fail closed)", async () => {
    await db
      .insertInto("deployment_settings")
      .values([
        { key: "externalSharing", value: JSON.stringify("maybe") },
        { key: "shareMaxExpiryDays", value: JSON.stringify(9999) },
        { key: "htmlRenderCdnAllowlist", value: JSON.stringify(["http://evil.example"]) },
      ])
      .execute();
    const res = await adminReq({ method: "GET", url: "/api/v1/admin/settings" });
    expect(res.json()).toMatchObject({
      externalSharing: { value: "deny", source: "db" },
      shareMaxExpiryDays: { value: 30, source: "db" },
      htmlRenderCdnAllowlist: [...HTML_CDN_ALLOWLIST_DEFAULT],
    });
  });

  it("a value set in the startup config wins and is read-only", async () => {
    const service = k.app.get(KernelConfigService);
    await service.apply(rawConfig({ sharing: { external: "allow", maxExpiryDays: 90 } }));
    try {
      const view = await adminReq({ method: "GET", url: "/api/v1/admin/settings" });
      expect(view.json()).toMatchObject({
        externalSharing: { value: "allow", source: "file" },
        shareMaxExpiryDays: { value: 90, source: "file" },
      });
      for (const [payload, path] of [
        [{ externalSharing: "deny" }, "externalSharing"],
        [{ shareMaxExpiryDays: 10 }, "shareMaxExpiryDays"],
      ] as const) {
        const locked = await putSettings(payload);
        expect(locked.statusCode, locked.body).toBe(409);
        expect(errCode(locked)).toBe("deployment.setting_readonly");
        expect(locked.json().error.details).toEqual([{ path, source: "file" }]);
      }
      // the org page shows what the platform allows
      const org = await adminReq({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
      expect(org.json().deployment).toMatchObject({
        externalSharing: { value: "allow", source: "file" },
        shareMaxExpiryDays: 90,
      });
    } finally {
      await service.apply(rawConfig());
    }
    const back = await adminReq({ method: "GET", url: "/api/v1/admin/settings" });
    expect(back.json().externalSharing).toEqual({ value: "deny", source: "default" });
  });
});

describe("org external sharing switch", () => {
  it("absent reads as off; on while the platform denies is refused", async () => {
    const got = await adminReq({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
    expect(got.json().settings.externalSharing).toBeUndefined();
    expect(got.json().deployment).toMatchObject({
      externalSharing: { value: "deny", source: "default" },
      shareMaxExpiryDays: 30,
    });
    const refused = await patchOrg({ externalSharing: "on" });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(errCode(refused)).toBe("org.external_sharing_not_allowed");
    // off is always fine
    const off = await patchOrg({ externalSharing: "off" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().settings.externalSharing).toBe("off");
  });

  it("with the platform allowing it, a person turns it on; a token may only turn it off", async () => {
    expect((await putSettings({ externalSharing: "allow" })).statusCode).toBe(200);
    const req = await viaToken();
    const url = `/api/v1/orgs/${orgId}/settings`;
    const viaPat = await req("PATCH", url, { externalSharing: "on" });
    expect(viaPat.statusCode, viaPat.body).toBe(400);
    expect(errCode(viaPat)).toBe("org.external_sharing_not_allowed");

    const on = await patchOrg({ externalSharing: "on" });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().settings.externalSharing).toBe("on");
    // on again through the token is no widening
    expect((await req("PATCH", url, { externalSharing: "on" })).statusCode).toBe(200);
    const off = await req("PATCH", url, { externalSharing: "off" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().settings.externalSharing).toBe("off");
    const cleared = await patchOrg({ externalSharing: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().settings.externalSharing).toBeUndefined();
    const stored = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(stored.settings).not.toHaveProperty("externalSharing");
  });

  it("an invalid stored org value reads as off", async () => {
    await sql`UPDATE capybara.orgs SET settings = settings || '{"externalSharing": "yes"}'::jsonb WHERE id = ${orgId}`.execute(
      raw,
    );
    const got = await adminReq({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
    expect(got.json().settings.externalSharing).toBe("off");
  });
});

describe("prompt suggestions switches", () => {
  const getAdmin = async () =>
    (await adminReq({ method: "GET", url: "/api/v1/admin/settings" })).json();
  const getOrg = async () =>
    (await adminReq({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` })).json();

  it("the platform switch: absent reads on; off; null clears; an invalid stored value reads off", async () => {
    expect((await getAdmin()).promptSuggestions).toBe("on");
    const off = await putSettings({ promptSuggestions: "off" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().promptSuggestions).toBe("off");
    expect((await getAdmin()).promptSuggestions).toBe("off");
    const cleared = await putSettings({ promptSuggestions: null });
    expect(cleared.json().promptSuggestions).toBe("on");
    expect(
      await db
        .selectFrom("deployment_settings")
        .select("key")
        .where("key", "=", "promptSuggestions")
        .execute(),
    ).toEqual([]);
    expect((await putSettings({ promptSuggestions: "maybe" })).statusCode).toBe(400);
    await db
      .insertInto("deployment_settings")
      .values({ key: "promptSuggestions", value: JSON.stringify("maybe") })
      .execute();
    expect((await getAdmin()).promptSuggestions).toBe("off");
  });

  it("the org switch: absent follows; off; null clears; platform off wins; an invalid value reads off", async () => {
    const url = `/api/v1/orgs/${orgId}/settings`;
    let got = await getOrg();
    expect(got.settings.promptSuggestions).toBeUndefined();
    expect(got.deployment.promptSuggestions).toBe("on");
    const off = await patchOrg({ promptSuggestions: "off" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().settings.promptSuggestions).toBe("off");
    const on = await patchOrg({ promptSuggestions: "on" });
    expect(on.json().settings.promptSuggestions).toBe("on");
    // an org on under a platform off stays storable; the deployment view shows the platform off
    await putSettings({ promptSuggestions: "off" });
    got = await getOrg();
    expect(got.settings.promptSuggestions).toBe("on");
    expect(got.deployment.promptSuggestions).toBe("off");
    // a token may widen or narrow it both ways
    const req = await viaToken();
    expect((await req("PATCH", url, { promptSuggestions: "off" })).statusCode).toBe(200);
    expect((await req("PATCH", url, { promptSuggestions: "on" })).statusCode).toBe(200);
    const cleared = await patchOrg({ promptSuggestions: null });
    expect(cleared.json().settings.promptSuggestions).toBeUndefined();
    const stored = await db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(stored.settings).not.toHaveProperty("promptSuggestions");
    await sql`UPDATE capybara.orgs SET settings = settings || '{"promptSuggestions": "yes"}'::jsonb WHERE id = ${orgId}`.execute(
      raw,
    );
    expect((await getOrg()).settings.promptSuggestions).toBe("off");
  });
});

describe("the file_shares table", () => {
  it("exists and checks audience and revoke_reason", async () => {
    const conv = randomUUID();
    const agent = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version) VALUES (${agent}, ${orgId}, ${adminId}, 'org', 1)`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id) VALUES (${conv}, ${orgId}, ${agent}, ${adminId})`.execute(
      raw,
    );
    const insert = (audience: string, revokeReason: string | null = null) =>
      sql`INSERT INTO capybara.file_shares
            (id, org_id, code, conversation_id, file_id, created_by, audience, name, content_type, size, object_key, revoke_reason)
          VALUES (${randomUUID()}, ${orgId}, ${randomUUID().slice(0, 10)}, ${conv}, ${randomUUID()}, ${adminId},
                  ${audience}, 'a.html', 'text/html', 10, 'shares/x/1', ${revokeReason})`.execute(
        raw,
      );
    await insert("internal");
    await insert("external", "creator_lost_access");
    await expect(insert("public")).rejects.toThrow(/check/i);
    await expect(insert("internal", "expired")).rejects.toThrow(/check/i);
    const rows = await db
      .selectFrom("file_shares")
      .select(["generation", "revoked_at", "last_opened_at", "expires_at"])
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ generation: 1, revoked_at: null, last_opened_at: null });
    // a deleted conversation takes its shares
    await sql`DELETE FROM capybara.conversations WHERE id = ${conv}`.execute(raw);
    expect(await db.selectFrom("file_shares").select("id").execute()).toEqual([]);
  });
});
