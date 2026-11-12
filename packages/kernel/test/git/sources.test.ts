import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHostEntry } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  GIT_IDENTITY_API_BASE,
  GIT_IDENTITY_TTL_SECONDS,
  GitIdentities,
  gitIdentityApiBase,
  parseGitHubUser,
} from "../../src/git/identity.js";
import { GitSources } from "../../src/git/sources.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { type ConnectorAuth, Credentials } from "../../src/tools/credentials.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Git sources and commit identity (sandbox git credentials spec §5.4, §6): whose connector serves
 * a git host for an actor (personal with the actor's own credential, org only with use_for_git,
 * one per host by the org pick / oauth_code / oldest, nothing for guests or while off), and the
 * GitHub identity read once through the credential, cached 24 h without the token.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let redis: Redis;
let api: FakeGitHubApi;
const lines: string[] = [];

let ownerId: string;
let aliceId: string;
let bobId: string;
let guestId: string;
let orgId: string;
let otherOrgId: string;

const GH: GitHostEntry[] = [{ host: "github.com", username: "x-access-token" }];
const PERSONAL: ConnectorAuth = { type: "bearer", ownership: "personal" };
const ORG_PAT: ConnectorAuth = { type: "bearer", ownership: "org" };
const OAUTH: ConnectorAuth = {
  type: "oauth_code",
  ownership: "personal",
  discovery: "manual",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  client: "manual",
};

/** A stand-in for the GitHub REST API: `GET /user` answers the user of the presented token. */
interface FakeGitHubApi {
  url: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  users: Map<string, unknown>;
  status: number | null;
  close(): Promise<void>;
}

async function startFakeGitHubApi(): Promise<FakeGitHubApi> {
  let server: Server | undefined;
  const api: FakeGitHubApi = {
    url: "",
    requests: [],
    users: new Map(),
    status: null,
    close: () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
  };
  server = createServer((req, res) => {
    api.requests.push({ path: req.url ?? "", headers: req.headers });
    const header = req.headers.authorization ?? "";
    const decoded = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString("utf8")
      : "";
    const user = api.users.get(decoded.slice(decoded.indexOf(":") + 1));
    const status = api.status ?? (req.url === "/user" && user !== undefined ? 200 : 401);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? user : { message: "Bad credentials" }));
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  api = await startFakeGitHubApi();
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    { roles: ["api"], tools: { timeoutMs: 5_000, oauthAllowInsecureLoopback: true } },
  );
  k = await startKernel(cfg, {
    logger: createLogger("debug", { write: (l) => lines.push(l) }),
    overrides: [
      {
        provide: GIT_IDENTITY_API_BASE,
        useValue: (host: string) =>
          host === "github.com" || host === "acme.ghe.com" ? api.url : null,
      },
    ],
  });
  redis = k.app.get<Redis>(REDIS);

  const accounts = accountsFor(db);
  const make = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  ownerId = await make("owner");
  aliceId = await make("alice");
  bobId = await make("bob");
  guestId = await make("guest");
  const owner = await session(k, "owner");
  orgId = await createOrg(owner, "Acme");
  otherOrgId = await createOrg(owner, "Other");
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  await db
    .insertInto("org_anonymous_accounts")
    .values({ org_id: orgId, account_id: guestId })
    .execute();
}, 180_000);

afterAll(async () => {
  await k?.close();
  await api?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await db.deleteFrom("secrets").where("namespace", "=", "kernel").execute();
  await db.deleteFrom("connectors").execute();
  await db.updateTable("orgs").set({ settings: "{}" }).execute();
  api.users.clear();
  api.requests.length = 0;
  api.status = null;
  const keys = await redis.keys("cache:git-identity:*");
  if (keys.length > 0) await redis.del(...keys);
});

const sources = () => k.app.get(GitSources);
const creds = () => k.app.get(Credentials);

/** A connector row (fake kind) declaring `hosts`. */
async function connector(
  auth: ConnectorAuth,
  o: {
    hosts?: GitHostEntry[] | null;
    useForGit?: boolean;
    createdAt?: Date;
    status?: "active" | "disabled";
    deleted?: boolean;
    org?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connectors")
    .values({
      id,
      org_id: o.org ?? orgId,
      slug: `c_${id.slice(0, 8)}`,
      name: `Conn ${id.slice(0, 4)}`,
      connector: "fake",
      endpoint: JSON.stringify({}),
      auth: JSON.stringify(auth),
      created_by: ownerId,
      git_hosts: o.hosts === null ? null : JSON.stringify(o.hosts ?? GH),
      use_for_git: o.useForGit ?? false,
      ...(o.createdAt && { created_at: o.createdAt }),
      ...(o.status && { status: o.status }),
      ...(o.deleted && { deleted_at: new Date() }),
    })
    .execute();
  return id;
}

const personalToken = (connectorId: string, accountId: string, token: string, org = orgId) =>
  creds().setStatic(org, connectorId, PERSONAL, { kind: "user", accountId }, { token });
const orgToken = (connectorId: string, token: string) =>
  creds().setStatic(orgId, connectorId, ORG_PAT, { kind: "org" }, { token });

const setGateway = (value: unknown) =>
  db
    .updateTable("orgs")
    .set({ settings: JSON.stringify({ gitGateway: value }) })
    .where("id", "=", orgId)
    .execute();

describe("sourcesFor", () => {
  it("personal connectors serve only the account that has its own credential", async () => {
    const c = await connector(PERSONAL);
    await personalToken(c, aliceId, "ghp_alice_000000001");
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([
      { host: "github.com", connectorId: c, username: "x-access-token", bot: false },
    ]);
    // Bob has no credential of his own: Alice's is never used for him
    expect(await sources().sourcesFor(orgId, bobId)).toEqual([]);
  });

  it("an org connector serves only with use_for_git (as the bot) and its org credential", async () => {
    const c = await connector(ORG_PAT);
    await orgToken(c, "ghp_bot_000000000001");
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
    await db.updateTable("connectors").set({ use_for_git: true }).where("id", "=", c).execute();
    const bot = [{ host: "github.com", connectorId: c, username: "x-access-token", bot: true }];
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual(bot);
    expect(await sources().sourcesFor(orgId, bobId)).toEqual(bot);
    // without the org credential it is no source
    await creds().clear(orgId, c, { kind: "org" });
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
  });

  it("an anonymous channel guest gets nothing, even with a credential row", async () => {
    const c = await connector(PERSONAL);
    await personalToken(c, guestId, "ghp_guest_00000001");
    const bot = await connector(ORG_PAT, { useForGit: true });
    await orgToken(bot, "ghp_bot_000000000002");
    expect(await sources().sourcesFor(orgId, guestId)).toEqual([]);
  });

  it("non-members, another org, and disabled, deleted or host-less connectors give nothing", async () => {
    const c = await connector(PERSONAL);
    await personalToken(c, aliceId, "ghp_alice_000000002");
    expect(await sources().sourcesFor(otherOrgId, aliceId)).toEqual([]);
    const other = await connector(PERSONAL, { org: otherOrgId });
    await personalToken(other, aliceId, "ghp_alice_000000003", otherOrgId);
    expect((await sources().sourcesFor(orgId, aliceId)).map((s) => s.connectorId)).toEqual([c]);

    await db.updateTable("connectors").set({ status: "disabled" }).where("id", "=", c).execute();
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
    const gone = await connector(PERSONAL, { deleted: true });
    await personalToken(gone, aliceId, "ghp_alice_000000004");
    const none = await connector(PERSONAL, { hosts: null });
    await personalToken(none, aliceId, "ghp_alice_000000005");
    const headers = await connector({ type: "headers", ownership: "personal", names: ["X-T"] });
    await creds().setStatic(
      orgId,
      headers,
      { type: "headers", ownership: "personal", names: ["X-T"] },
      { kind: "user", accountId: aliceId },
      { headers: { "X-T": "v-alice-0000000001" } },
    );
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
  });

  it("nothing while the gateway is off: the org switch, an invalid setting, tools.git.enabled", async () => {
    const c = await connector(PERSONAL);
    await personalToken(c, aliceId, "ghp_alice_000000006");
    await setGateway({ enabled: false });
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
    await setGateway({ enabled: "no" });
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
    await setGateway({ enabled: true });
    expect(await sources().sourcesFor(orgId, aliceId)).toHaveLength(1);
    const config = k.app.get(KernelConfigService);
    const on = config.get();
    config.apply({ ...on, tools: { ...on.tools, git: { ...on.tools.git, enabled: false } } });
    try {
      expect(await sources().sourcesFor(orgId, aliceId)).toEqual([]);
    } finally {
      config.apply(on);
    }
  });

  it("one source per host: the org pick, else the oauth_code one, else the oldest", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const t2 = new Date("2026-03-01T00:00:00Z");
    const oldPat = await connector(PERSONAL, { createdAt: t0 });
    const newPat = await connector(PERSONAL, { createdAt: t1 });
    await personalToken(oldPat, aliceId, "ghp_alice_000000007");
    await personalToken(newPat, aliceId, "ghp_alice_000000008");
    const pick = async () => (await sources().sourcesFor(orgId, aliceId)).map((s) => s.connectorId);
    // two static ones: the oldest
    expect(await pick()).toEqual([oldPat]);

    // an authorization-code one wins over older static ones
    const oauth = await connector(OAUTH, { createdAt: t2 });
    await creds().setOAuthTokens(
      orgId,
      oauth,
      { kind: "user", accountId: aliceId },
      { access_token: "gho_alice_00000001", expires_at: null, token_type: "Bearer" },
    );
    expect(await pick()).toEqual([oauth]);
    // Bob has only the newer PAT: he gets that one
    await personalToken(newPat, bobId, "ghp_bob_0000000001");
    expect((await sources().sourcesFor(orgId, bobId)).map((s) => s.connectorId)).toEqual([newPat]);

    // the org's pick is org-wide: it wins over the oauth_code one
    await setGateway({ hostSources: { "github.com": newPat } });
    expect(await pick()).toEqual([newPat]);
    expect((await sources().sourcesFor(orgId, bobId)).map((s) => s.connectorId)).toEqual([newPat]);
    // oauth picked: Bob cannot use it and gets no source for the host (no fallback to his PAT)
    await setGateway({ hostSources: { "github.com": oauth } });
    expect(await pick()).toEqual([oauth]);
    expect(await sources().sourcesFor(orgId, bobId)).toEqual([]);
    // a pick naming an unknown connector: nobody gets a source for the host
    await setGateway({ hostSources: { "github.com": randomUUID() } });
    expect(await pick()).toEqual([]);
    // the pick is per host: another host's pick leaves the default rules here
    await setGateway({ hostSources: { "gitlab.com": newPat } });
    expect(await pick()).toEqual([oauth]);
  });

  it("a pick of a personal connector never falls back to a use_for_git bot", async () => {
    const mine = await connector(PERSONAL);
    await personalToken(mine, aliceId, "ghp_alice_000000011");
    const bot = await connector(ORG_PAT, { useForGit: true });
    await orgToken(bot, "ghp_bot_000000000003");
    await setGateway({ hostSources: { "github.com": mine } });
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([
      { host: "github.com", connectorId: mine, username: "x-access-token", bot: false },
    ]);
    // Bob has no credential on the picked connector: nothing, not the bot
    expect(await sources().sourcesFor(orgId, bobId)).toEqual([]);
    // the bot picked: everyone gets the bot, Alice's own connection is not used
    await setGateway({ hostSources: { "github.com": bot } });
    for (const a of [aliceId, bobId]) {
      expect((await sources().sourcesFor(orgId, a)).map((s) => [s.connectorId, s.bot])).toEqual([
        [bot, true],
      ]);
    }
  });

  it("a connector with several hosts serves each; hosts are picked independently", async () => {
    const ghe: GitHostEntry = { host: "acme.ghe.com", username: "x-access-token" };
    const both = await connector(PERSONAL, { hosts: [...GH, ghe], createdAt: new Date(0) });
    const gheOnly = await connector(PERSONAL, { hosts: [ghe] });
    await personalToken(both, aliceId, "ghp_alice_000000009");
    await personalToken(gheOnly, aliceId, "ghp_alice_000000010");
    await setGateway({ hostSources: { "acme.ghe.com": gheOnly } });
    expect(await sources().sourcesFor(orgId, aliceId)).toEqual([
      { host: "acme.ghe.com", connectorId: gheOnly, username: "x-access-token", bot: false },
      { host: "github.com", connectorId: both, username: "x-access-token", bot: false },
    ]);
  });
});

describe("gitIdentity", () => {
  it("derives the API base from the git host", () => {
    expect(gitIdentityApiBase("github.com")).toBe("https://api.github.com");
    expect(gitIdentityApiBase("acme.ghe.com")).toBe("https://api.acme.ghe.com");
    expect(gitIdentityApiBase("gitlab.com")).toBeNull();
    expect(gitIdentityApiBase("evil.github.com")).toBeNull();
    expect(gitIdentityApiBase("a.b.ghe.com")).toBeNull();
    expect(gitIdentityApiBase("ghe.com")).toBeNull();
  });

  it("parses only a user-shaped answer, with a cleaned display name", () => {
    expect(parseGitHubUser({ login: "octo", id: 42, name: "Octo\nCat\u0007" })).toEqual({
      login: "octo",
      id: 42,
      name: "Octo Cat",
    });
    expect(parseGitHubUser({ login: "octo", id: 42, name: "  " })?.name).toBeNull();
    expect(parseGitHubUser({ login: "bad login", id: 42 })).toBeNull();
    expect(parseGitHubUser({ login: "octo", id: "42" })).toBeNull();
    expect(parseGitHubUser(null)).toBeNull();
  });

  it("reads GET /user once with the Basic credential, caches 24 h without the token", async () => {
    const token = "ghp_alice_identity_0001";
    const c = await connector(PERSONAL);
    await personalToken(c, aliceId, token);
    api.users.set(token, { login: "alice-gh", id: 1001, name: "Alice Liddell" });
    const ids = k.app.get(GitIdentities);
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).toEqual({
      name: "Alice Liddell",
      email: "1001+alice-gh@users.noreply.github.com",
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.path).toBe("/user");
    expect(api.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    );
    // cached: no second request
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).not.toBeNull();
    expect(api.requests).toHaveLength(1);
    const key = `cache:git-identity:${orgId}:${c}:${aliceId}:github.com`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(GIT_IDENTITY_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(GIT_IDENTITY_TTL_SECONDS);
    const stored = (await redis.get(key)) as string;
    expect(JSON.parse(stored)).toEqual({ name: "Alice Liddell", login: "alice-gh", id: 1001 });
    expect(stored).not.toContain(token);
    // Redis holds the token nowhere
    for (const k2 of await redis.keys("*")) {
      const type = await redis.type(k2);
      if (type === "string") expect(await redis.get(k2)).not.toContain(token);
    }
  });

  it("falls back to the login, uses the ghe.com noreply domain, null for other hosts", async () => {
    const ghe: GitHostEntry = { host: "acme.ghe.com", username: "x-access-token" };
    const gl: GitHostEntry = { host: "gitlab.com", username: "oauth2" };
    const c = await connector(PERSONAL, { hosts: [ghe, gl] });
    await personalToken(c, aliceId, "ghp_alice_identity_0002");
    api.users.set("ghp_alice_identity_0002", { login: "alice_acme", id: 7, name: null });
    const ids = k.app.get(GitIdentities);
    expect(await ids.gitIdentity(orgId, c, aliceId, "acme.ghe.com")).toEqual({
      name: "alice_acme",
      email: "7+alice_acme@users.noreply.acme.ghe.com",
    });
    expect(await ids.gitIdentity(orgId, c, aliceId, "gitlab.com")).toBeNull();
    // a host the connector does not declare, another org, another account without a credential
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).toBeNull();
    expect(await ids.gitIdentity(otherOrgId, c, aliceId, "acme.ghe.com")).toBeNull();
    expect(await ids.gitIdentity(orgId, c, bobId, "acme.ghe.com")).toBeNull();
    expect(api.requests).toHaveLength(1);
  });

  it("a refused lookup is null, not cached, and the token is in no log line", async () => {
    const token = "ghp_alice_identity_0003";
    const c = await connector(PERSONAL);
    await personalToken(c, aliceId, token);
    const before = lines.length;
    const ids = k.app.get(GitIdentities);
    // unknown token: 401 (static credential, nothing to refresh, retried once)
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).toBeNull();
    api.status = 500;
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).toBeNull();
    expect(await redis.keys("cache:git-identity:*")).toEqual([]);
    api.status = null;
    api.users.set(token, { login: "alice-gh", id: 1001 });
    expect(await ids.gitIdentity(orgId, c, aliceId, "github.com")).toEqual({
      name: "alice-gh",
      email: "1001+alice-gh@users.noreply.github.com",
    });
    const logged = lines.slice(before).join("\n");
    expect(logged).toContain("git identity: the user lookup failed");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
  });
});
