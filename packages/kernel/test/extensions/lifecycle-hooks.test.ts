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
import { LIFECYCLE_DELIVERY_HOOKS, LifecycleHooks } from "../../src/extensions/lifecycle-hooks.js";
import { AccountsService } from "../../src/identity/accounts.js";
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
 * org record one delivery per subscribing plugin in the deleting transaction and deliver it
 * through the lifecycle queue, also to a plugin the org switched off; a rollback records nothing;
 * a throwing handler is retried until it succeeds, and is then delivered once.
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

/** The kernel's delivery rows of a mount with this payload. */
async function recorded(mount: string, payload: object) {
  return db
    .selectFrom("lifecycle_deliveries")
    .selectAll()
    .where("mount", "=", mount as "org.deleted")
    .where(sql<boolean>`payload = ${JSON.stringify(payload)}::jsonb`)
    .execute();
}

/** Waits until the delivery row is marked delivered, then returns the fixture's deliveries. */
async function delivered(mount: string, payload: object): Promise<Row[]> {
  await waitFor(
    async () => {
      const rows = await recorded(mount, payload);
      return rows.length > 0 && rows.every((r) => r.delivered_at !== null);
    },
    15_000,
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

/** Inserts a delivery row by hand (for a plugin the subscriber query would not pick). */
async function insertRow(plugin: string, payload: object): Promise<string> {
  const row = await db
    .insertInto("lifecycle_deliveries")
    .values({ mount: "org.deleted", payload: JSON.stringify(payload), plugin })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
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
    { overrides: [{ provide: LIFECYCLE_DELIVERY_HOOKS, useValue: { backoffMs: 100 } }] },
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
}, 180_000);

afterAll(async () => {
  await k?.close().catch(() => {});
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("lifecycle hooks", { timeout: 60_000 }, () => {
  it("removing a member records one row per subscribing plugin and delivers it once", async () => {
    const orgId = await createOrg(req, "Members");
    const accountId = await newMember(orgId, "leaver");
    const res = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${accountId}` });
    expect(res.statusCode, res.body).toBe(204);
    const payload = { orgId, accountId };
    const rows = await recorded("org.member_removed", payload);
    expect(rows.map((r) => r.plugin)).toEqual([PLUGIN]);
    expect(await delivered("org.member_removed", payload)).toEqual([
      { mount: "org.member_removed", payload },
    ]);
    const [row] = await recorded("org.member_removed", payload);
    expect(row?.attempts).toBe(1);
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

  it("a plugin not loaded on this replica: the attempt throws and the row stays undelivered", async () => {
    const id = await insertRow("ghost-plugin", { orgId: "00000000-0000-0000-0000-000000000001" });
    const hooks = k.app.get(LifecycleHooks);
    await expect(hooks.process({ deliveryId: id }, new AbortController().signal)).rejects.toThrow(
      /ghost-plugin is not loaded on this replica/,
    );
    const row = await db
      .selectFrom("lifecycle_deliveries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it("a loaded plugin without a handler: dropped with a warning", async () => {
    // model-fake is loaded here and registered no lifecycle hook
    const id = await insertRow("model-fake", { orgId: "00000000-0000-0000-0000-000000000002" });
    const hooks = k.app.get(LifecycleHooks);
    const warn = vi.spyOn((hooks as unknown as { log: { warn: () => void } }).log, "warn");
    try {
      await hooks.process({ deliveryId: id }, new AbortController().signal);
      expect(warn).toHaveBeenCalledWith(
        "lifecycle hook delivery dropped: the plugin registered no handler",
        expect.objectContaining({ deliveryId: id, plugin: "model-fake" }),
      );
    } finally {
      warn.mockRestore();
    }
    const row = await db
      .selectFrom("lifecycle_deliveries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.delivered_at).not.toBeNull();
    expect(row.attempts).toBe(0);
  });

  it("a rolled-back offboarding records nothing", async () => {
    const orgId = await createOrg(req, "Rollback");
    const accountId = await newMember(orgId, "stayer");
    const boom = new Error("roll back");
    await expect(
      k.app.get(TransactionHost).run(async () => {
        await k.app.get(Offboarding).offboard(orgId, accountId, "removed");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await recorded("org.member_removed", { orgId, accountId })).toEqual([]);
    const member = await db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    expect(member?.role).toBe("member");
  });

  it("a handler that throws twice is retried and delivered once (attempts 3)", async () => {
    const config = k.app.get(ExtensionDeploymentConfigService);
    await config.put(PLUGIN, { failTimes: 2 }, ownerId);
    try {
      const orgId = await createOrg(req, "Retry");
      const accountId = await newMember(orgId, "flaky");
      await k.app.get(MembersService).remove(orgId, accountId, ownerId);
      const payload = { orgId, accountId };
      expect(await delivered("org.member_removed", payload)).toHaveLength(1);
      const [row] = await recorded("org.member_removed", payload);
      expect(row?.attempts).toBe(3);
      const calls = await sql<{ n: string }>`SELECT count(*) AS n FROM plugin_fake_lifecycle.calls
        WHERE payload = ${JSON.stringify(payload)}::jsonb`.execute(raw);
      expect(Number(calls.rows[0]?.n)).toBe(3);
    } finally {
      await config.clear(PLUGIN, ownerId);
    }
  });
});
