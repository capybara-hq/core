import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  type GitTicketRequest,
  GitTickets,
  gitGatewayOrigin,
  gitRunTicketsKey,
  gitTicketKey,
  hashGitTicket,
} from "../../src/git/tickets.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { REDIS } from "../../src/infra/tokens.js";
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
 * Git gateway run tickets (sandbox git credentials spec §4, §5.1, §9): hash-only storage in Redis
 * with a TTL, live re-checks on resolve (run, membership, switches), revocation per run, and a
 * ticket issued on one replica resolved on another.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let cfg: KernelConfig;
/**
 * Replicas A and B (api role: no worker sweeps the hand-made runs) on the same PostgreSQL and
 * Redis.
 */
let a: TestKernel;
let b: TestKernel;
let redis: Redis;

let ownerId: string;
let aliceId: string;
let orgId: string;
let otherOrgId: string;
let agentId: string;
let otherAgentId: string;
let owner: Req;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  cfg = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] });
  a = await startKernel(cfg);
  b = await startKernel(cfg);
  redis = a.app.get<Redis>(REDIS);

  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  aliceId = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  owner = await session(a, "owner");
  orgId = await createOrg(owner, "Acme");
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  agentId = await createAgent(owner, orgId);
  otherOrgId = await createOrg(owner, "Other");
  otherAgentId = await createAgent(owner, otherOrgId);
});

afterAll(async () => {
  await b?.close();
  await a?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A new run with the given status, in a new conversation (one active run per conversation). */
async function newRun(
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" = "running",
  inOtherOrg = false,
): Promise<string> {
  const conversationId = inOtherOrg
    ? await createConv(owner, otherOrgId, otherAgentId)
    : await createConv(owner, orgId, agentId);
  const id = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id,
      conversation_id: conversationId,
      status,
      agent_version: 1,
      trigger_account_id: ownerId,
      trigger_seq: 0,
    })
    .execute();
  return id;
}

const request = (runId: string, over: Partial<GitTicketRequest> = {}): GitTicketRequest => ({
  orgId,
  accountId: aliceId,
  runId,
  execId: `exec-${randomUUID()}`,
  hosts: ["github.com"],
  ...over,
});

const ticketsA = () => a.app.get(GitTickets);
const ticketsB = () => b.app.get(GitTickets);

describe("issue and resolve", () => {
  it("round-trips the binding and stores only the hash, with the ticket TTL", async () => {
    const runId = await newRun();
    const req = request(runId, { repos: ["acme/app"] });
    const before = Date.now();
    const ticket = await ticketsA().issue(req);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(ticket, "base64url")).toHaveLength(32);

    const binding = await ticketsA().resolve(ticket);
    expect(binding).toMatchObject(req);
    expect(binding?.issuedAt).toBeGreaterThanOrEqual(before);

    // the raw ticket appears in no Redis key or value
    const keys = await redis.keys("*");
    expect(keys.some((k) => k.includes(ticket))).toBe(false);
    for (const k of keys) {
      const type = await redis.type(k);
      const values =
        type === "string"
          ? [await redis.get(k)]
          : type === "set"
            ? await redis.smembers(k)
            : type === "hash"
              ? Object.values(await redis.hgetall(k))
              : type === "list"
                ? await redis.lrange(k, 0, -1)
                : type === "zset"
                  ? await redis.zrange(k, "0", "-1")
                  : [];
      for (const v of values) expect(v ?? "").not.toContain(ticket);
    }

    const hash = hashGitTicket(ticket);
    expect(await redis.exists(gitTicketKey(hash))).toBe(1);
    expect(await redis.smembers(gitRunTicketsKey(runId))).toEqual([hash]);
    const ttl = cfg.tools.git.ticketTtlSeconds;
    const keyTtl = await redis.ttl(gitTicketKey(hash));
    expect(keyTtl).toBeGreaterThan(ttl - 5);
    expect(keyTtl).toBeLessThanOrEqual(ttl);
    const setTtl = await redis.ttl(gitRunTicketsKey(runId));
    expect(setTtl).toBeGreaterThan(ttl - 5);
    expect(setTtl).toBeLessThanOrEqual(ttl);
  });

  it("resolves on another replica what one issued", async () => {
    const runId = await newRun();
    const ticket = await ticketsA().issue(request(runId));
    expect((await ticketsB().resolve(ticket))?.runId).toBe(runId);
    const back = await ticketsB().issue(request(runId));
    expect((await ticketsA().resolve(back))?.runId).toBe(runId);
  });

  it("accepts queued and waiting runs", async () => {
    for (const status of ["queued", "waiting"] as const) {
      const ticket = await ticketsA().issue(request(await newRun(status)));
      expect(await ticketsA().resolve(ticket)).not.toBeNull();
    }
  });

  it("throws when a command of the MULTI fails, leaving no binding behind", async () => {
    const runId = await newRun();
    // a run set of the wrong type makes SADD fail inside the MULTI (exec() still resolves)
    await redis.set(gitRunTicketsKey(runId), "not-a-set", "EX", 60);
    const before = (await redis.keys("git-ticket:*")).sort();
    await expect(ticketsA().issue(request(runId))).rejects.toThrow(/storing the binding/);
    expect((await redis.keys("git-ticket:*")).sort()).toEqual(before);
    await redis.del(gitRunTicketsKey(runId));
  });

  it("refuses unknown and malformed tickets", async () => {
    expect(await ticketsA().resolve(Buffer.alloc(32, 1).toString("base64url"))).toBeNull();
    expect(await ticketsA().resolve("not a ticket")).toBeNull();
    expect(await ticketsA().resolve("")).toBeNull();
  });

  it("refuses an expired ticket", async () => {
    const ticket = await ticketsA().issue(request(await newRun()));
    await redis.pexpire(gitTicketKey(hashGitTicket(ticket)), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await ticketsA().resolve(ticket)).toBeNull();
  });
});

describe("revocation and live checks", () => {
  it("never shortens the run set's TTL when a ticket is issued", async () => {
    const runId = await newRun();
    const setKey = gitRunTicketsKey(runId);
    await ticketsA().issue(request(runId));
    // a longer TTL on the set (an earlier, longer ticket TTL) survives a later issue
    await redis.expire(setKey, 100_000);
    await ticketsA().issue(request(runId));
    expect(await redis.ttl(setKey)).toBeGreaterThan(99_000);
    // a shorter one is extended to the ticket TTL
    await redis.expire(setKey, 5);
    await ticketsA().issue(request(runId));
    expect(await redis.ttl(setKey)).toBeGreaterThan(5);
  });

  it("revokes atomically: a ticket issued during a revocation is never left unlisted", async () => {
    const runId = await newRun();
    const issued: string[] = [];
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      work.push(
        ticketsA()
          .issue(request(runId))
          .then((t) => issued.push(t)),
      );
      if (i % 8 === 4) work.push(ticketsB().revokeRun(runId));
    }
    await Promise.all(work);
    const listed = new Set(await redis.smembers(gitRunTicketsKey(runId)));
    for (const t of issued) {
      const hash = hashGitTicket(t);
      // a live ticket is always in the set a later revocation reads
      if ((await redis.exists(gitTicketKey(hash))) === 1) expect(listed.has(hash)).toBe(true);
    }
    await ticketsA().revokeRun(runId);
    for (const t of issued) expect(await ticketsA().resolve(t)).toBeNull();
    expect(await redis.exists(gitRunTicketsKey(runId))).toBe(0);
  });

  it("revokeRun deletes every ticket of the run and leaves other runs alone", async () => {
    const runId = await newRun();
    const other = await newRun();
    const t1 = await ticketsA().issue(request(runId));
    const t2 = await ticketsA().issue(request(runId));
    const t3 = await ticketsA().issue(request(other));
    await ticketsB().revokeRun(runId);
    expect(await ticketsA().resolve(t1)).toBeNull();
    expect(await ticketsA().resolve(t2)).toBeNull();
    expect(await redis.exists(gitRunTicketsKey(runId))).toBe(0);
    expect(await ticketsA().resolve(t3)).not.toBeNull();
    // a run without tickets is a no-op
    await ticketsA().revokeRun(randomUUID());
  });

  it.each(["completed", "failed", "aborted"] as const)("refuses once the run is %s", async (s) => {
    const runId = await newRun();
    const ticket = await ticketsA().issue(request(runId));
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
    await db.updateTable("runs").set({ status: s }).where("id", "=", runId).execute();
    expect(await ticketsA().resolve(ticket)).toBeNull();
  });

  it("refuses a ticket whose run is in another org (cross-org misuse)", async () => {
    const runId = await newRun("running", true);
    const ticket = await ticketsA().issue(request(runId));
    expect(await ticketsA().resolve(ticket)).toBeNull();
    // and a run that does not exist
    expect(await ticketsA().resolve(await ticketsA().issue(request(randomUUID())))).toBeNull();
  });

  it("refuses once the account is removed from the org", async () => {
    const accounts = accountsFor(db);
    const bob = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
    await testMembers(db).add(orgId, bob, "member", ownerId);
    const ticket = await ticketsA().issue(request(await newRun(), { accountId: bob }));
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
    await db
      .deleteFrom("memberships")
      .where("org_id", "=", orgId)
      .where("account_id", "=", bob)
      .execute();
    expect(await ticketsA().resolve(ticket)).toBeNull();
  });

  it("refuses once the account is disabled", async () => {
    const accounts = accountsFor(db);
    const carol = (await accounts.createLocal({ login: "carol", password: PW, displayName: "C" }))
      .id;
    await testMembers(db).add(orgId, carol, "member", ownerId);
    const ticket = await ticketsA().issue(request(await newRun(), { accountId: carol }));
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", carol).execute();
    expect(await ticketsA().resolve(ticket)).toBeNull();
  });

  it("refuses while tools.git.enabled is off (read per call)", async () => {
    const ticket = await ticketsA().issue(request(await newRun()));
    const config = a.app.get(KernelConfigService);
    const on = config.get();
    config.apply({ ...on, tools: { ...on.tools, git: { ...on.tools.git, enabled: false } } });
    try {
      expect(config.get().tools.git.enabled).toBe(false);
      expect(await ticketsA().resolve(ticket)).toBeNull();
      // the other replica's switch is its own config
      expect(await ticketsB().resolve(ticket)).not.toBeNull();
    } finally {
      config.apply(on);
    }
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
  });

  it("refuses while the org switched the gateway off", async () => {
    const ticket = await ticketsA().issue(request(await newRun()));
    const setGateway = (value: unknown) =>
      db
        .updateTable("orgs")
        .set({ settings: JSON.stringify({ gitGateway: value }) })
        .where("id", "=", orgId)
        .execute();
    await setGateway({ enabled: false });
    expect(await ticketsA().resolve(ticket)).toBeNull();
    await setGateway({ enabled: true });
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
    // an invalid stored value fails closed: the gateway reads as off
    await setGateway("off");
    expect(await ticketsA().resolve(ticket)).toBeNull();
    await setGateway({ enabled: "yes" });
    expect(await ticketsA().resolve(ticket)).toBeNull();
    await setGateway({ enabled: true, hostSources: ["github.com"] });
    expect(await ticketsA().resolve(ticket)).toBeNull();
    await db.updateTable("orgs").set({ settings: "{}" }).where("id", "=", orgId).execute();
    expect(await ticketsA().resolve(ticket)).not.toBeNull();
  });
});

describe("gitGatewayOrigin", () => {
  const of = (git: { gatewayUrl?: string }, publicUrl?: string) =>
    gitGatewayOrigin({
      tools: { ...cfg.tools, git: { ...cfg.tools.git, ...git } },
      http: { ...cfg.http, ...(publicUrl !== undefined && { publicUrl }) },
    });

  it("prefers tools.git.gatewayUrl, falls back to http.publicUrl, else null", () => {
    expect(of({ gatewayUrl: "https://kernel.internal:8080/" }, "https://cap.example.com")).toBe(
      "https://kernel.internal:8080",
    );
    expect(of({}, "https://cap.example.com/")).toBe("https://cap.example.com");
    expect(of({})).toBeNull();
  });
});
