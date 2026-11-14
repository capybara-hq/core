import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionDeploymentConfigService } from "../../src/extensions/deployment-config.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import {
  LIFECYCLE_JOB,
  LIFECYCLE_QUEUE,
  LifecycleHooks,
  lifecycleJobId,
} from "../../src/extensions/lifecycle-hooks.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { Offboarding } from "../../src/orgs/offboarding.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Lifecycle hooks (memory plugin spec §6.3): removing a member, deleting an agent and deleting an
 * org owe one outbox job per subscribing plugin in the deleting transaction, delivered through the
 * lifecycle queue, also to a plugin the org switched off; a rollback owes nothing; a throwing
 * handler is retried until it succeeds, and is then delivered once.
 */

const PLUGIN = "fake-lifecycle";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let req: Req;
let ownerId: string;

type Row = { mount: string; payload: Record<string, string> };

/** The fixture's successful deliveries of a mount with this payload. */
async function deliveries(mount: string, payload: object): Promise<Row[]> {
  const r = await sql<Row>`SELECT mount, payload FROM plugin_fake_lifecycle.deliveries
    WHERE mount = ${mount} AND payload = ${JSON.stringify(payload)}::jsonb`.execute(raw);
  return r.rows;
}

/** Handler calls of the fixture (successful or not) with this payload. */
async function calls(payload: object): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM plugin_fake_lifecycle.calls
    WHERE payload = ${JSON.stringify(payload)}::jsonb`.execute(raw);
  return Number(r.rows[0]?.n);
}

/** The pending outbox rows of lifecycle jobs with this job id. */
async function owed(jobId: string) {
  return db
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "org_id"])
    .where("job_name", "=", LIFECYCLE_JOB)
    .where("job_id", "=", jobId)
    .execute();
}

/** Waits until the fixture recorded a successful delivery, then returns its deliveries. */
async function delivered(mount: string, payload: object): Promise<Row[]> {
  await waitFor(
    async () => (await deliveries(mount, payload)).length > 0,
    30_000,
    `${mount} delivered`,
  );
  return deliveries(mount, payload);
}

async function newMember(orgId: string, login: string): Promise<string> {
  const acc = await k.app
    .get(AccountsService)
    .createLocal({ login, password: PW, displayName: login });
  await k.app.get(MembersService).add(orgId, acc.id, "member", ownerId);
  return acc.id;
}

/** Switches the fixture off in the org (its own switch row). */
async function switchOff(orgId: string): Promise<void> {
  await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
    VALUES (${PLUGIN}, ${orgId}, false)
    ON CONFLICT (plugin, org_id) DO UPDATE SET enabled = false`.execute(raw);
}

/** Stores an org copy of the fixture's config that does not validate (label over 10 characters). */
async function invalidCopy(orgId: string): Promise<void> {
  await db
    .insertInto("extension_org_overrides")
    .values({
      plugin: PLUGIN,
      org_id: orgId,
      config: JSON.stringify({ label: "far too long for the limit" }),
      created_by: ownerId,
      updated_by: ownerId,
    })
    .execute();
  const effective = await k.app.get(EffectiveConfigs).get(orgId, PLUGIN);
  expect(effective.ok).toBe(false);
}

async function newAgent(orgId: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Doomed",
        instructions: "Be brief.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (
    await k.app.get(AccountsService).createLocal({
      login: "owner",
      password: PW,
      displayName: "Owner",
      superAdmin: true,
    })
  ).id;
  req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode, res.body).toBe(200);
});

afterAll(async () => {
  await k?.close().catch(() => {});
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("lifecycle hooks", () => {
  it("the job id names the mount, the plugin and the payload's ids, without ':'", () => {
    expect(lifecycleJobId("org.member_removed", "memory", { orgId: "o1", accountId: "a1" })).toBe(
      "lifecycle-org-member_removed-memory-a1-o1",
    );
    expect(lifecycleJobId("org.deleted", "p", { orgId: "x:y" })).toBe(
      "lifecycle-org-deleted-p-x-y",
    );
  });

  it("removing a member owes one job per subscribing plugin and delivers it once", async () => {
    const orgId = await createOrg(req, "Members");
    const accountId = await newMember(orgId, "leaver");
    const res = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${accountId}` });
    expect(res.statusCode, res.body).toBe(204);
    const payload = { orgId, accountId };
    expect(await delivered("org.member_removed", payload)).toEqual([
      { mount: "org.member_removed", payload },
    ]);
    // delivered: the outbox row is gone, and the handler ran once
    const jobId = lifecycleJobId("org.member_removed", PLUGIN, payload);
    await waitFor(async () => (await owed(jobId)).length === 0, 10_000, "outbox row delivered");
    // nothing-happened window: a second delivery would land in this gap
    await new Promise((r) => setTimeout(r, 500));
    expect(await calls(payload)).toBe(1);
  });

  it("deleting an agent delivers agent.deleted, also with the plugin switched off in the org", async () => {
    const orgId = await createOrg(req, "Agents");
    const agentId = await newAgent(orgId);
    await switchOff(orgId);
    await k.app.get(AgentsService).softDelete(orgId, agentId, ownerId);
    const payload = { orgId, agentId };
    expect(await delivered("agent.deleted", payload)).toEqual([
      { mount: "agent.deleted", payload },
    ]);
  });

  it("deleting an org delivers org.deleted, also with the plugin switched off in the org", async () => {
    const orgId = await createOrg(req, "Gone");
    await switchOff(orgId);
    const owner = await k.app.get(AccountsService).get(ownerId);
    await k.app.get(OrgsService).softDelete(orgId, owner as never);
    const payload = { orgId };
    expect(await delivered("org.deleted", payload)).toEqual([{ mount: "org.deleted", payload }]);
  });

  it("removing a member delivers with the plugin switched off and an invalid org config", async () => {
    const orgId = await createOrg(req, "Invalid");
    const accountId = await newMember(orgId, "offcfg");
    await switchOff(orgId);
    await invalidCopy(orgId);
    await k.app.get(MembersService).remove(orgId, accountId, ownerId);
    const payload = { orgId, accountId };
    expect(await delivered("org.member_removed", payload)).toEqual([
      { mount: "org.member_removed", payload },
    ]);
  });

  it("a plugin not loaded on this replica: the attempt throws (BullMQ retries it)", async () => {
    const hooks = k.app.get(LifecycleHooks);
    const job = {
      mount: "org.deleted" as const,
      plugin: "ghost-plugin",
      payload: { orgId: "00000000-0000-0000-0000-000000000001" },
    };
    await expect(hooks.process(job, new AbortController().signal)).rejects.toThrow(
      /ghost-plugin is not loaded on this replica/,
    );
  });

  it("a loaded plugin without a handler: dropped with a warning", async () => {
    // model-fake is loaded here and registered no lifecycle hook
    const hooks = k.app.get(LifecycleHooks);
    const warn = vi.spyOn((hooks as unknown as { log: { warn: () => void } }).log, "warn");
    try {
      await hooks.process(
        {
          mount: "org.deleted",
          plugin: "model-fake",
          payload: { orgId: "00000000-0000-0000-0000-000000000002" },
        },
        new AbortController().signal,
      );
      expect(warn).toHaveBeenCalledWith(
        "lifecycle hook delivery dropped: the plugin registered no handler",
        expect.objectContaining({ mount: "org.deleted", plugin: "model-fake" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the offboard transaction owes the job (no org id); a rollback owes nothing", async () => {
    const orgId = await createOrg(req, "Rollback");
    const accountId = await newMember(orgId, "stayer");
    const payload = { orgId, accountId };
    const jobId = lifecycleJobId("org.member_removed", PLUGIN, payload);
    const boom = new Error("roll back");
    let inTx: Awaited<ReturnType<typeof owed>> = [];
    await expect(
      k.app.get(TransactionHost).run(async () => {
        await k.app.get(Offboarding).offboard(orgId, accountId, "removed");
        inTx = await k.app
          .get(KernelDb)
          .db.selectFrom("outbox")
          .select(["queue", "job_name", "job_id", "data", "org_id"])
          .where("job_id", "=", jobId)
          .execute();
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(inTx).toEqual([
      {
        queue: LIFECYCLE_QUEUE,
        job_name: LIFECYCLE_JOB,
        job_id: jobId,
        data: { mount: "org.member_removed", plugin: PLUGIN, payload },
        org_id: null,
      },
    ]);
    expect(await owed(jobId)).toEqual([]);
    expect(await calls(payload)).toBe(0);
    const member = await db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    expect(member?.role).toBe("member");
  });

  it("a handler that throws twice is retried (2 s, 4 s) and delivered once", async () => {
    const config = k.app.get(ExtensionDeploymentConfigService);
    await config.put(PLUGIN, { failTimes: 2 }, ownerId);
    try {
      const orgId = await createOrg(req, "Retry");
      const accountId = await newMember(orgId, "flaky");
      await k.app.get(MembersService).remove(orgId, accountId, ownerId);
      const payload = { orgId, accountId };
      expect(await delivered("org.member_removed", payload)).toHaveLength(1);
      expect(await calls(payload)).toBe(3);
    } finally {
      await config.clear(PLUGIN, ownerId);
    }
  });
});
