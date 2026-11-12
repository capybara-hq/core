import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHostEntry } from "@capybara-hq/plugin-sdk";
import {
  type FakeGitServer,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  GIT_UPSTREAM_ORIGIN,
  gitBytesKey,
  gitConcurrencyKey,
  parseGitGatewayPath,
  repoAllowed,
} from "../../src/git/gateway.js";
import { type GitTicketRequest, GitTickets } from "../../src/git/tickets.js";
import { REDIS } from "../../src/infra/tokens.js";
import { createLogger } from "../../src/log.js";
import { type ConnectorAuth, Credentials } from "../../src/tools/credentials.js";
import { gitAskKey } from "../../src/tools/git-asks.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The git gateway route (sandbox git credentials spec §5, §7, §9, §10) end to end with a real git
 * client: clone, fetch and push through `/git/v1/*` with a run ticket, configured the way the
 * sandbox will be (`GIT_CONFIG_COUNT` env: `insteadOf`, `extraHeader`, an empty credential
 * helper), against a fake git host standing in for github.com (the `GIT_UPSTREAM_ORIGIN` seam).
 * The fake requires the actor's token as Basic auth and records no credential value.
 */

const TOKEN = `ghp_${randomBytes(18).toString("hex")}`;
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const GH: GitHostEntry[] = [{ host: "github.com", username: "x-access-token" }];
const PERSONAL: ConnectorAuth = { type: "bearer", ownership: "personal" };
const MAX_CONCURRENT = 3;
const MAX_BYTES = 1024 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let redis: Redis;
let fake: FakeGitServer;
/** A custom upstream for one test (null: the fake git host). */
let upstream: string | null = null;
const lines: string[] = [];
const tickets: string[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

let ownerId: string;
let aliceId: string;
let orgId: string;
let owner: Req;
let agentId: string;
let connectorId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  fake = await startFakeGitServer({
    repos: ["acme/app", "acme/other"],
    requireBasic: { username: "x-access-token", password: TOKEN },
    recordAuthorization: false,
  });
  const fakeOrigin = new URL(fake.url("acme/app")).origin;
  const cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api"],
      tools: {
        timeoutMs: 5_000,
        oauthAllowInsecureLoopback: true,
        git: {
          maxConcurrentPerOrg: MAX_CONCURRENT,
          maxBytesPerRun: MAX_BYTES,
          idleTimeoutMs: 5_000,
        },
      },
    },
  );
  k = await startKernel(cfg, {
    logger: createLogger("debug", { write: (l) => lines.push(l) }),
    overrides: [
      {
        provide: GIT_UPSTREAM_ORIGIN,
        useValue: (host: string) =>
          host === "github.com" ? (upstream ?? fakeOrigin) : `https://${host}`,
      },
    ],
  });
  redis = k.app.get<Redis>(REDIS);

  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner, "Acme");
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  agentId = await createAgent(owner, orgId);

  connectorId = randomUUID();
  await db
    .insertInto("connectors")
    .values({
      id: connectorId,
      org_id: orgId,
      slug: "github",
      name: "GitHub",
      connector: "fake",
      endpoint: JSON.stringify({}),
      auth: JSON.stringify(PERSONAL),
      created_by: ownerId,
      git_hosts: JSON.stringify(GH),
    })
    .execute();
  await k.app
    .get(Credentials)
    .setStatic(
      orgId,
      connectorId,
      PERSONAL,
      { kind: "user", accountId: aliceId },
      { token: TOKEN },
    );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await fake?.stop();
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

beforeEach(async () => {
  upstream = null;
  fake.requests.length = 0;
  await db.updateTable("connectors").set({ git_push_policy: "ask" }).execute();
});

/** A running run of a new conversation and a ticket for one exec of it. */
async function ticketFor(over: Partial<GitTicketRequest> = {}): Promise<{
  ticket: string;
  runId: string;
  execId: string;
}> {
  const conversationId = await createConv(owner, orgId, agentId);
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conversationId,
      status: "running",
      agent_version: 1,
      trigger_account_id: aliceId,
      trigger_seq: 0,
    })
    .execute();
  const execId = `exec-${randomUUID()}`;
  const ticket = await k.app.get(GitTickets).issue({
    orgId,
    accountId: aliceId,
    runId,
    execId,
    hosts: ["github.com"],
    ...over,
  });
  tickets.push(ticket);
  return { ticket, runId, execId };
}

const gateway = () => `http://127.0.0.1:${k.port}/git/v1`;

/** The environment git gets in the sandbox (spec §5.4), with an isolated HOME. */
async function gitEnv(ticket: string): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "capybara-gw-home-"));
  dirs.push(home);
  const gw = gateway();
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Alice",
    GIT_AUTHOR_EMAIL: "alice@example.com",
    GIT_COMMITTER_NAME: "Alice",
    GIT_COMMITTER_EMAIL: "alice@example.com",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: `url.${gw}/github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: `url.${gw}/github.com/.insteadOf`,
    GIT_CONFIG_VALUE_1: "git@github.com:",
    GIT_CONFIG_KEY_2: `http.${gw}/.extraHeader`,
    GIT_CONFIG_VALUE_2: `Authorization: Bearer ${ticket}`,
    GIT_CONFIG_KEY_3: `credential.${gw}/.helper`,
    GIT_CONFIG_VALUE_3: "",
  };
}

/** Runs git; resolves with the exit code and the combined output. */
function git(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { env, cwd: cwd ?? env.HOME, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    p.stderr.on("data", (b: Buffer) => {
      out += b.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

/** Clones acme/app through the gateway (the remote is written as on GitHub). */
async function clone(env: NodeJS.ProcessEnv, url = "https://github.com/acme/app.git") {
  const dir = join(env.HOME ?? "", `app-${randomUUID().slice(0, 6)}`);
  const r = await git(["clone", "--quiet", url, dir], env);
  return { ...r, dir };
}

/** Commits a new file in `dir`; returns the commit sha. */
async function commitIn(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  await writeFile(join(dir, `f-${randomUUID().slice(0, 6)}.txt`), "change\n");
  expect((await git(["add", "-A"], env, dir)).code).toBe(0);
  expect((await git(["commit", "--quiet", "-m", "change"], env, dir)).code).toBe(0);
  return (await git(["rev-parse", "HEAD"], env, dir)).out.trim();
}

const receivePosts = () =>
  fake.requests.filter((r) => r.method === "POST" && r.service === "git-receive-pack");

describe("path parsing and repo allowlists", () => {
  it("accepts only the smart-HTTP endpoints", () => {
    expect(
      parseGitGatewayPath(
        "GET",
        "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack",
      ),
    ).toMatchObject({ host: "github.com", repo: "acme/app", endpoint: "info/refs" });
    expect(
      parseGitGatewayPath("POST", "/git/v1/github.com/Acme/App/git-receive-pack"),
    ).toMatchObject({ path: "Acme/App", repo: "acme/app", service: "git-receive-pack" });
    for (const [m, u] of [
      ["GET", "/git/v1/github.com/acme/app.git/info/refs"],
      ["GET", "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack&x=1"],
      ["POST", "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/github.com/acme/app.git/git-upload-pack"],
      ["POST", "/git/v1/github.com/acme/app.git/git-upload-pack?x=1"],
      ["GET", "/git/v1/github.com/acme/app.git/HEAD"],
      ["GET", "/git/v1/github.com/acme/app.git/objects/info/packs"],
      ["GET", "/git/v1/github.com/a/b/c.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/github.com/../app.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/127.0.0.1/acme/app.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/github.com:22/acme/app.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/user@github.com/acme/app.git/info/refs?service=git-upload-pack"],
    ] as const) {
      expect(parseGitGatewayPath(m, u), `${m} ${u}`).toBeNull();
    }
  });

  it("matches exact repos, owner wildcards and no list", () => {
    expect(repoAllowed(undefined, "acme/app")).toBe(true);
    expect(repoAllowed(["Acme/App.git"], "acme/app")).toBe(true);
    expect(repoAllowed(["acme/*"], "acme/app")).toBe(true);
    expect(repoAllowed(["acme/*"], "acmex/app")).toBe(false);
    expect(repoAllowed(["acme/other"], "acme/app")).toBe(false);
    expect(repoAllowed([], "acme/app")).toBe(false);
  });
});

describe("clone, fetch and push with a real git client", { timeout: 30_000 }, () => {
  it("clones and fetches with the actor's token added upstream and the ticket never sent", async () => {
    const { ticket } = await ticketFor();
    const env = await gitEnv(ticket);
    const c = await clone(env);
    expect(c.code, c.out).toBe(0);
    const sha = await fake.commit("acme/app", { "README.md": "seed\n", "new.txt": "x\n" });
    const f = await git(["pull", "--quiet", "--ff-only"], env, c.dir);
    expect(f.code, f.out).toBe(0);
    expect((await git(["rev-parse", "HEAD"], env, c.dir)).out.trim()).toBe(sha);
    // an ssh-style remote is rewritten to the gateway too
    const s = await clone(env, "git@github.com:acme/app.git");
    expect(s.code, s.out).toBe(0);

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      // authorized = the Basic value of the actor's token, so the client's Bearer ticket was not sent
      expect(r.authorized).toBe(true);
      expect(r.authorization).toBeUndefined();
      expect(r.headerNames).not.toContain("cookie");
    }
  });

  it("asks before a push: no upstream push, the ask record written, git shows the note", async () => {
    const { ticket, execId } = await ticketFor();
    const env = await gitEnv(ticket);
    const c = await clone(env);
    expect(c.code, c.out).toBe(0);
    const before = await fake.refOf("acme/app", "refs/heads/main");
    await commitIn(c.dir, env);
    fake.requests.length = 0;
    const p = await git(["push", "origin", "HEAD:main"], env, c.dir);
    expect(p.code).not.toBe(0);
    expect(p.out).toContain("remote: Capybara: [git] Push to acme/app needs approval");
    expect(p.out).toContain("[remote rejected]");
    expect(receivePosts()).toHaveLength(0);
    expect(await fake.refOf("acme/app", "refs/heads/main")).toBe(before);
    const record = JSON.parse((await redis.get(gitAskKey(execId))) ?? "null");
    expect(record).toEqual({
      host: "github.com",
      repo: "acme/app",
      refs: ["refs/heads/main"],
      connectorId,
    });
    expect(await redis.ttl(gitAskKey(execId))).toBeGreaterThan(0);
  });

  it("refuses a denied push before the ref advertisement", async () => {
    await db.updateTable("connectors").set({ git_push_policy: "deny" }).execute();
    const { ticket, execId } = await ticketFor();
    const env = await gitEnv(ticket);
    const c = await clone(env);
    expect(c.code, c.out).toBe(0);
    await commitIn(c.dir, env);
    fake.requests.length = 0;
    const p = await git(["push", "origin", "HEAD:main"], env, c.dir);
    expect(p.code).not.toBe(0);
    expect(p.out).toContain(
      "fatal: remote error: Capybara: [git] The push to acme/app was not made",
    );
    expect(p.out).toContain("not allowed by this organization's policy");
    expect(fake.requests.filter((r) => r.service === "git-receive-pack")).toHaveLength(0);
    expect(JSON.parse((await redis.get(gitAskKey(execId))) ?? "null")).toMatchObject({
      repo: "acme/app",
      outcome: "denied",
    });
  });

  it("relays an allowed push: the host's ref moves to the new commit", async () => {
    await db.updateTable("connectors").set({ git_push_policy: "allow" }).execute();
    const { ticket, execId } = await ticketFor();
    const env = await gitEnv(ticket);
    const c = await clone(env);
    expect(c.code, c.out).toBe(0);
    const sha = await commitIn(c.dir, env);
    const p = await git(["push", "origin", "HEAD:refs/heads/feat-x"], env, c.dir);
    expect(p.code, p.out).toBe(0);
    expect(await fake.refOf("acme/app", "refs/heads/feat-x")).toBe(sha);
    expect(receivePosts()).toHaveLength(1);
    expect(await redis.get(gitAskKey(execId))).toBeNull();
  });

  it("refuses a repository outside the ticket's allowlist", async () => {
    const { ticket } = await ticketFor({ repos: ["acme/other"] });
    const env = await gitEnv(ticket);
    const c = await clone(env);
    expect(c.code).not.toBe(0);
    expect(c.out).toContain("remote: Capybara: this task may not use the repository acme/app.");
    expect(fake.requests).toHaveLength(0);
    expect((await clone(env, "https://github.com/acme/other.git")).code).toBe(0);
  });
});

describe("refusals", { timeout: 30_000 }, () => {
  it("answers 403 with a git-readable message for an unknown, expired or revoked ticket", async () => {
    const bogus = randomBytes(32).toString("base64url");
    const c1 = await clone(await gitEnv(bogus));
    expect(c1.code).not.toBe(0);
    expect(c1.out).toContain("remote: Capybara: the git ticket is not valid");

    const { ticket, runId } = await ticketFor();
    await k.app.get(GitTickets).revokeRun(runId);
    const c2 = await clone(await gitEnv(ticket));
    expect(c2.code).not.toBe(0);
    expect(c2.out).toContain("remote: Capybara: the git ticket is not valid");

    const ended = await ticketFor();
    await db
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", ended.runId)
      .execute();
    const c3 = await clone(await gitEnv(ended.ticket));
    expect(c3.out).toContain("remote: Capybara: the git ticket is not valid");
    expect(fake.requests).toHaveLength(0);

    const none = await k.http.inject({
      method: "GET",
      url: "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack",
    });
    expect(none.statusCode).toBe(403);
    expect(none.headers["www-authenticate"]).toBeUndefined();
  });

  it("answers 404 for another host, path or method", async () => {
    const { ticket } = await ticketFor();
    const auth = { authorization: `Bearer ${ticket}` };
    for (const [method, url] of [
      ["GET", "/git/v1/gitlab.com/acme/app.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/v1/github.com/acme/app.git/info/refs"],
      ["GET", "/git/v1/github.com/acme/app.git/HEAD"],
      ["GET", "/git/v1/github.com/acme/app.git/git-upload-pack"],
      ["HEAD", "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack"],
      ["PUT", "/git/v1/github.com/acme/app.git/git-receive-pack"],
      ["DELETE", "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack"],
    ] as const) {
      const res = await k.http.inject({ method, url, headers: auth });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const wrongType = await k.http.inject({
      method: "POST",
      url: "/git/v1/github.com/acme/app.git/git-upload-pack",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{}",
    });
    expect(wrongType.statusCode).toBe(404);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an upstream redirect", async () => {
    const { ticket } = await ticketFor();
    fake.redirectNext("https://evil.example.com/acme/app.git/info/refs");
    const c = await clone(await gitEnv(ticket));
    expect(c.code).not.toBe(0);
    expect(c.out).toContain("redirect, which is not followed");
  });

  it("relays only the allowed headers both ways", async () => {
    const { ticket } = await ticketFor();
    const seen: string[][] = [];
    const custom: Server = createServer((req, res) => {
      seen.push(Object.keys(req.headers));
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
        "set-cookie": "session=secret",
        "www-authenticate": 'Basic realm="x"',
        "x-github-request-id": "abc",
      });
      res.end("001e# service=git-upload-pack\n0000");
    });
    await new Promise<void>((r) => custom.listen(0, "127.0.0.1", r));
    upstream = `http://127.0.0.1:${(custom.address() as AddressInfo).port}`;
    try {
      const res = await k.http.inject({
        method: "GET",
        url: "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack",
        headers: {
          authorization: `Bearer ${ticket}`,
          cookie: "cap_at=abc",
          "x-forwarded-for": "10.0.0.1",
          "x-custom": "1",
          "git-protocol": "version=2",
          "user-agent": "git/2.45",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.headers["www-authenticate"]).toBeUndefined();
      expect(res.headers["x-github-request-id"]).toBeUndefined();
      expect(res.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
    } finally {
      await new Promise<void>((r) => custom.close(() => r()));
    }
    const names = seen[0] ?? [];
    expect(names).toContain("git-protocol");
    expect(names).toContain("authorization");
    for (const n of ["cookie", "x-forwarded-for", "x-custom"]) expect(names).not.toContain(n);
  });

  it("refreshes once after an upstream 401 on the ref advertisement and succeeds", async () => {
    const { ticket } = await ticketFor();
    fake.failNext(401);
    const c = await clone(await gitEnv(ticket));
    expect(c.code, c.out).toBe(0);
    const ads = fake.requests.filter((r) => r.path.includes("/info/refs"));
    expect(ads.length).toBe(2);
    expect(lines.some((l) => l.includes('"refreshed":true'))).toBe(true);
  });

  it("answers a reconnect message when the upstream keeps refusing", async () => {
    const { ticket } = await ticketFor();
    upstream = await (async () => {
      const s = createServer((_req, res) => res.writeHead(401).end());
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      servers.push(s);
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    })();
    const c = await clone(await gitEnv(ticket));
    expect(c.code).not.toBe(0);
    expect(c.out).toContain("remote: Capybara: github.com refused the connection's credential");
  });

  it("gives up on an upstream that sends nothing within the idle timeout", async () => {
    const { ticket } = await ticketFor();
    const s = createServer(() => {});
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    upstream = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const started = Date.now();
    const res = await k.http.inject({
      method: "GET",
      url: "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack",
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(res.statusCode).toBe(504);
    expect(res.body).toContain("no data within the idle timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  });

  it("enforces the byte cap per run", async () => {
    const { ticket, runId } = await ticketFor();
    await redis.set(gitBytesKey(runId), String(MAX_BYTES), "EX", 60);
    const c1 = await clone(await gitEnv(ticket));
    expect(c1.code).not.toBe(0);
    expect(c1.out).toContain("transfer limit");
    expect(fake.requests).toHaveLength(0);

    // just under the cap: the transfer goes over it and is cut
    await redis.set(gitBytesKey(runId), String(MAX_BYTES - 200), "EX", 60);
    const c2 = await clone(await gitEnv(ticket));
    expect(c2.code).not.toBe(0);
    expect(Number(await redis.get(gitBytesKey(runId)))).toBeGreaterThan(MAX_BYTES);
    expect(await redis.ttl(gitBytesKey(runId))).toBeGreaterThan(0);
  });

  it("enforces the per-org concurrency and frees the slot after each request", async () => {
    const { ticket } = await ticketFor();
    const key = gitConcurrencyKey(orgId);
    await redis.set(key, String(MAX_CONCURRENT), "EX", 60);
    const busy = await k.http.inject({
      method: "GET",
      url: "/git/v1/github.com/acme/app.git/info/refs?service=git-upload-pack",
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(busy.statusCode).toBe(429);
    expect(busy.body).toContain("too many git transfers");
    expect(await redis.get(key)).toBe(String(MAX_CONCURRENT));
    await redis.del(key);
    const c = await clone(await gitEnv(ticket));
    expect(c.code, c.out).toBe(0);
    await expect.poll(async () => Number((await redis.get(key)) ?? 0)).toBe(0);
    expect(await redis.ttl(key)).not.toBe(-1);
  });
});

describe("secrets in logs", () => {
  it("logs neither the token nor any ticket", () => {
    expect(lines.some((l) => l.includes("git gateway request"))).toBe(true);
    const all = lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(BASIC);
    for (const t of tickets) expect(all).not.toContain(t);
  });
});
