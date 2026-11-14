import { randomUUID } from "node:crypto";
import type { ToolError } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { QueueLostJobs } from "../../src/runtime/queue-lost-jobs.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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
 * Task 7 of Platform phase 2: the accounts, orgs, admin and models operations against PG with the
 * real services. Operations run by `op.run(input, ctx)`, refusals by `availability()`, the card's
 * preconditions by `precheck`. `accounts.create` runs end to end in accounts-create-e2e.test.ts.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let ops: PlatformOperations;
let root: Req;
let rootId: string;
let memberId: string;
let orgId: string;
let org2: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
  ops = k.app.get(PlatformOperations);
  rootId = (
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  memberId = (await accountsFor(db).createLocal({ login: "mem", password: PW, displayName: "Mem" }))
    .id;
  root = await session(k, "root");
  orgId = await createOrg(root, "Acme");
  org2 = await createOrg(root, "Beta Corp");
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${memberId}, 'member')`.execute(db);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const facts = (role: ActorFacts["role"], over: Partial<ActorFacts> = {}): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
  ...over,
});

const ctxOf = (accountId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

const run = (id: string, input: unknown, ctx: OperationContext = ctxOf(rootId)) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "superAdmin"));
  });
};

const precheck = (id: string, input: unknown, ctx: OperationContext = ctxOf(rootId)) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};

const summarize = async (id: string, input: unknown, ctx: OperationContext = ctxOf(rootId)) =>
  op(id).summary?.(op(id).input.parse(input), ctx);

const auditOf = async (action: string, operation: string) => {
  const rows = await db
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "=", action)
    .execute();
  return rows.find((r) => (r.detail as Record<string, unknown>).operation === operation)?.detail;
};

describe("registration and who may call", () => {
  it("registers the operations of the accounts, orgs, admin and models domains", () => {
    expect(
      ops
        .all()
        .map((o) => o.id)
        .filter((id) => /^(accounts|orgs|admin|models)\./.test(id)),
    ).toEqual([
      "accounts.create",
      "accounts.disable",
      "accounts.enable",
      "accounts.get",
      "accounts.list",
      "admin.agent-delete",
      "admin.agent-get",
      "admin.agents-list",
      "admin.attention",
      "admin.audit",
      "admin.connector-delete",
      "admin.connector-get",
      "admin.connector-set-status",
      "admin.connectors-list",
      "admin.health",
      "admin.org-members",
      "admin.outbox-discard",
      "admin.outbox-list-dead",
      "admin.outbox-retry",
      "admin.overview",
      "admin.settings",
      "admin.update-settings",
      "admin.usage",
      "models.available",
      "models.catalog",
      "models.platform-list",
      "models.platform-purposes",
      "models.prices",
      "models.purposes",
      "models.set-disabled",
      "models.set-platform-disabled",
      "models.set-platform-purpose",
      "models.set-price",
      "models.set-purpose",
      "orgs.current",
      "orgs.get",
      "orgs.list",
      "orgs.members",
      "orgs.set-limits",
      "orgs.update",
    ]);
  });

  it("an org owner who is not the super admin cannot reach the admin console operations", () => {
    for (const id of ["accounts.list", "accounts.create", "orgs.set-limits", "models.set-price"]) {
      const a = availability(op(id), facts("owner"));
      expect(a.ok, id).toBe(false);
      expect(a.ok ? "" : a.reason).toContain("super admin");
    }
  });

  it("the super admin through a shared agent is refused, naming the private agent", () => {
    const a = availability(
      op("accounts.create"),
      facts("owner", { isSuperAdmin: true, agentPrivateToActor: false }),
    );
    expect(a.ok ? "" : a.reason).toContain("private agent");
    expect(availability(op("accounts.create"), facts("owner", { isSuperAdmin: true }))).toEqual({
      ok: true,
    });
  });

  it("a member reads the org and its members but cannot rename it", () => {
    expect(availability(op("orgs.current"), facts("member"))).toEqual({ ok: true });
    expect(availability(op("orgs.members"), facts("member"))).toEqual({ ok: true });
    const a = availability(op("orgs.update"), facts("member"));
    expect(a.ok ? "" : a.reason).toContain("admin");
  });

  it("platform writes are confirmed every time; reads run", () => {
    for (const id of [
      "accounts.create",
      "accounts.disable",
      "accounts.enable",
      "orgs.set-limits",
      "admin.update-settings",
      "models.set-platform-disabled",
      "models.set-price",
      "models.set-platform-purpose",
    ]) {
      expect(op(id).confirm, id).toBe("platform");
    }
    expect(op("orgs.update").confirm).toBe("org");
    expect(op("accounts.list").confirm).toBe("read");
  });
});

describe("accounts", () => {
  it("lists compact rows with the login and reads one account with its orgs", async () => {
    const list = (await run("accounts.list", {})) as {
      items: { id: string; name: string; state: string; login: string | null }[];
      next: string | null;
    };
    expect(list.items).toContainEqual(
      expect.objectContaining({ id: rootId, name: "Root", state: "active", login: "root" }),
    );
    expect(list.next).toBeNull();
    const got = (await run("accounts.get", { accountId: memberId })) as {
      account: { login: string; mustChangePassword: boolean };
      orgs: { id: string; role: string }[];
    };
    expect(got.account).toMatchObject({ login: "mem", mustChangePassword: false });
    expect(got.orgs).toEqual([expect.objectContaining({ id: orgId, role: "member" })]);
    const missing = (await run("accounts.get", { accountId: "nope" }).catch(
      (e: unknown) => e,
    )) as ToolError;
    expect(missing.message).toContain("accounts.list");
  });

  it("accounts.create outside an approved call creates nothing and says where to do it", async () => {
    const e = (await run("accounts.create", { login: "nocall", displayName: "No call" }).catch(
      (x: unknown) => x,
    )) as ToolError;
    expect(e.message).toContain("account.create_needs_approval");
    expect(e.message).toContain("private agent");
    expect(
      await db
        .selectFrom("identities")
        .select("account_id")
        .where("external_id", "=", "nocall")
        .execute(),
    ).toEqual([]);
  });

  it("the precheck refuses disabling yourself and enabling an active account, before the card", async () => {
    expect(await precheck("accounts.disable", { accountId: rootId })).toMatchObject({
      ok: false,
      code: "account.self",
    });
    expect(await precheck("accounts.enable", { accountId: memberId })).toMatchObject({
      ok: false,
      code: "account.no_change",
    });
    expect(await precheck("accounts.disable", { accountId: "nope" })).toMatchObject({
      ok: false,
      code: "account.not_found",
    });
  });

  it("disables and enables an account; the summary names it and the audit says via agent", async () => {
    const mem = await session(k, "mem");
    expect(await precheck("accounts.disable", { accountId: memberId })).toEqual({ ok: true });
    expect(await summarize("accounts.disable", { accountId: memberId })).toEqual({
      zh: "停用账号「Mem (mem)」",
      en: 'Disable account "Mem (mem)"',
    });
    const off = (await run("accounts.disable", { accountId: memberId })) as {
      account: { status: string };
    };
    expect(off.account.status).toBe("disabled");
    expect((await mem({ method: "GET", url: "/api/v1/me" })).statusCode).not.toBe(200);
    expect(await auditOf("account.updated", "accounts.disable")).toMatchObject({
      status: "disabled",
      via: "agent",
      operation: "accounts.disable",
    });
    const on = (await run("accounts.enable", { accountId: memberId })) as {
      account: { status: string };
    };
    expect(on.account.status).toBe("active");
  });
});

describe("orgs", () => {
  it("lists every org with member counts and reads one with its limits", async () => {
    const list = (await run("orgs.list", {})) as {
      items: { id: string; name: string; memberCount: number }[];
      limitDefaults: { runConcurrency: number };
    };
    expect(list.items.map((o) => o.name).sort()).toEqual(["Acme", "Beta Corp"]);
    expect(list.items.find((o) => o.id === orgId)?.memberCount).toBe(2);
    expect(list.limitDefaults.runConcurrency).toBeGreaterThan(0);
    const got = (await run("orgs.get", { orgId: org2 })) as {
      org: { name: string };
      limits: { runConcurrency: number | null };
    };
    expect(got).toMatchObject({ org: { name: "Beta Corp" }, limits: { runConcurrency: null } });
  });

  it("sets an org's limits through the deployment settings; null goes back to the default", async () => {
    expect(await precheck("orgs.set-limits", { orgId: "nope", runConcurrency: 3 })).toMatchObject({
      ok: false,
      code: "org.not_found",
    });
    expect(
      await summarize("orgs.set-limits", { orgId: org2, runConcurrency: 3, sandbox: null }),
    ).toEqual({
      zh: "修改组织「Beta Corp」的限额：runConcurrency=3，sandbox=default",
      en: 'Set the limits of org "Beta Corp": runConcurrency=3, sandbox=default',
    });
    const out = (await run("orgs.set-limits", { orgId: org2, runConcurrency: 3 })) as {
      limits: { runConcurrency: number | null };
    };
    expect(out.limits.runConcurrency).toBe(3);
    expect(await auditOf("deployment.settings.updated", "orgs.set-limits")).toMatchObject({
      runConcurrencyOverrides: { [org2]: 3 },
      via: "agent",
    });
    await run("orgs.set-limits", { orgId: org2, runConcurrency: null });
    const back = (await run("orgs.get", { orgId: org2 })) as {
      limits: { runConcurrency: number | null };
    };
    expect(back.limits.runConcurrency).toBeNull();
  });

  it("reads this org and its members, and renames it (slug taken refused before the card)", async () => {
    expect(await run("orgs.current", {})).toMatchObject({ org: { name: "Acme" }, role: "owner" });
    const members = (await run("orgs.members", {}, ctxOf(memberId))) as {
      items: { id: string; state: string }[];
    };
    expect(members.items).toContainEqual(
      expect.objectContaining({ id: memberId, state: "member" }),
    );
    const beta = (await run("orgs.get", { orgId: org2 })) as { org: { slug: string } };
    expect(await precheck("orgs.update", { slug: beta.org.slug })).toMatchObject({
      ok: false,
      code: "org.slug_taken",
    });
    const out = (await run("orgs.update", { name: "Acme Research" })) as { org: { name: string } };
    expect(out.org.name).toBe("Acme Research");
    expect(await auditOf("org.updated", "orgs.update")).toMatchObject({
      after: { name: "Acme Research" },
      via: "agent",
    });
  });
});

describe("admin and models", () => {
  it("reads the overview and settings, and changes a deployment setting", async () => {
    // the same numbers as GET /admin/overview, nothing else
    const overview = await run("admin.overview", {});
    expect(Object.keys(overview as object).sort()).toEqual([
      "accounts",
      "attentionTotal",
      "orgs",
      "partial",
    ]);
    expect(overview).toMatchObject({ orgs: 2, accounts: 2 });
    expect((await root({ method: "GET", url: "/api/v1/admin/overview" })).json()).toEqual(overview);
    expect(await run("admin.settings", {})).toMatchObject({ orgCreation: "anyone" });
    const out = await run("admin.update-settings", { orgCreation: "super_admin" });
    expect(out).toMatchObject({ orgCreation: "super_admin" });
    expect(await auditOf("deployment.settings.updated", "admin.update-settings")).toMatchObject({
      orgCreation: "super_admin",
      via: "agent",
    });
    await run("admin.update-settings", { orgCreation: "anyone" });
  });

  it("admin.health answers what GET /admin/overview/health does", async () => {
    const out = (await run("admin.health", {})) as Record<string, unknown>;
    const res = (
      await root({ method: "GET", url: "/api/v1/admin/overview/health" })
    ).json() as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(Object.keys(res).sort());
    // live numbers may move between the two reads; the stable parts are equal
    expect(out.kernel).toEqual(res.kernel);
    expect(out.unavailable).toEqual([]);
    expect(out.roles).toMatchObject({ api: 1, worker: 1 });
    expect((out.queues as { name: string }[]).map((q) => q.name)).toEqual(
      (res.queues as { name: string }[]).map((q) => q.name),
    );
  });

  it("admin.usage answers what GET /admin/overview/usage does, from the route's schema", async () => {
    const out = await run("admin.usage", { tz: "Asia/Shanghai" });
    const res = await root({
      method: "GET",
      url: "/api/v1/admin/overview/usage?tz=Asia%2FShanghai",
    });
    expect(res.statusCode, res.body).toBe(200);
    // the first read cached the week: the route serves the same answer
    expect(out).toEqual(res.json());
    expect((out as { days: unknown[] }).days).toHaveLength(7);
    expect(op("admin.usage").description).toContain("estimate");
    expect(op("admin.usage").description).toContain("eval replay runs included");
  });

  it("admin.attention reads compact rows with more and unavailable, never an error text", async () => {
    const o = op("admin.attention");
    expect(o.confirm).toBe("read");
    expect(availability(o, facts("owner")).ok).toBe(false);
    const spy = vi.spyOn(k.app.get(ProviderRegistry), "listWithStatus").mockResolvedValue([
      {
        provider: "model-x",
        plugin: "model-x",
        status: "error",
        error: "upstream said sk-SECRET-123 is invalid",
        models: [],
      },
    ]);
    try {
      const out = (await run("admin.attention", {})) as {
        items: Record<string, unknown>[];
        more: Record<string, number>;
        unavailable: string[];
      };
      expect(Object.keys(out).sort()).toEqual(["items", "more", "unavailable"]);
      expect(out.more).toEqual({ extensions: 0, updates: 0, providers: 0, outbox: 0, queue: 0 });
      expect(out.unavailable).toEqual([]);
      const row = out.items.find((r) => r.kind === "provider");
      expect(row).toEqual({
        kind: "provider",
        id: "model-x",
        name: "model-x",
        state: "error",
        reason: "list_failed",
        next: expect.stringContaining("/admin/extensions/model-x"),
      });
      for (const r of out.items) {
        expect(Object.keys(r).sort()).toEqual(["id", "kind", "name", "next", "reason", "state"]);
      }
      expect(JSON.stringify(out)).not.toContain("sk-SECRET");
      // a source that fails is named, its rows absent
      spy.mockRejectedValue(new Error("boom sk-SECRET-123"));
      const failed = (await run("admin.attention", {})) as typeof out;
      expect(failed.unavailable).toEqual(["providers"]);
      expect(failed.items.some((r) => r.kind === "provider")).toBe(false);
      expect(JSON.stringify(failed)).not.toContain("sk-SECRET");
    } finally {
      spy.mockRestore();
    }
  });

  it("admin.attention lists the run queue's lost jobs as one queue row with its next step", async () => {
    const spy = vi
      .spyOn(k.app.get(QueueLostJobs), "summary")
      .mockResolvedValue({ count: 2, lastAt: "2026-11-12T08:00:00.000Z" });
    try {
      const out = (await run("admin.attention", {})) as { items: Record<string, unknown>[] };
      expect(out.items.filter((r) => r.kind === "queue")).toEqual([
        {
          kind: "queue",
          id: "queue_lost_jobs",
          name: "The queue lost background jobs",
          state: "lost_jobs",
          reason: expect.stringContaining("2 queued run job(s)"),
          next: expect.stringContaining("Redis lost data"),
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("admin.audit pages the platform-level audit log like GET /admin/audit, without detail", async () => {
    const o = op("admin.audit");
    expect(o.confirm).toBe("read");
    expect(o.description).toContain("pass the returned next as params.after");
    expect(availability(o, facts("owner")).ok).toBe(false);
    const all = (await run("admin.audit", { limit: 100 })) as {
      events: { id: string; action: string; viaAgent: boolean }[];
      next: string | null;
    };
    // the deployment settings change through admin.update-settings above, by the agent
    expect(all.events).toContainEqual(
      expect.objectContaining({ action: "deployment.settings.updated", viaAgent: true }),
    );
    expect(JSON.stringify(all)).not.toContain('"detail"');
    const one = (await run("admin.audit", { limit: 1 })) as typeof all;
    expect(one.events).toEqual([all.events[0]]);
    const after = (await run("admin.audit", { limit: 1, after: one.next })) as typeof all;
    expect(after.events).toEqual([all.events[1]]);
    // the same rows as the route
    const http = await root({ method: "GET", url: "/api/v1/admin/audit?limit=100" });
    expect(http.json()).toEqual(all);
  });

  it("admin.update-settings lowers the platform's sandbox tiers but never raises them", async () => {
    expect(await run("admin.settings", {})).toMatchObject({
      sandboxTiers: { max: "dev", default: "dev", allowUnsandboxed: true },
    });
    for (const sandboxTiers of [{ max: "open" }, { max: null }]) {
      // { max: null } is no raise while the stored max is the default; set it first
      await root({
        method: "PUT",
        url: "/api/v1/admin/settings",
        payload: { sandboxTiers: { max: "dev" } },
      });
      expect(await precheck("admin.update-settings", { sandboxTiers })).toMatchObject({
        ok: sandboxTiers.max === null,
      });
    }
    await root({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { sandboxTiers: { max: "strict", default: "strict" } },
    });
    for (const sandboxTiers of [{ max: "dev" }, { max: null, default: null }, { default: "dev" }]) {
      expect(await precheck("admin.update-settings", { sandboxTiers })).toMatchObject({
        ok: false,
        code:
          sandboxTiers.default === "dev"
            ? "validation_failed"
            : "deployment.sandbox_tier_not_allowed",
      });
      await expect(run("admin.update-settings", { sandboxTiers })).rejects.toThrow();
    }
    const out = await run("admin.update-settings", { sandboxTiers: { allowUnsandboxed: false } });
    expect(out).toMatchObject({
      sandboxTiers: { max: "strict", default: "strict", allowUnsandboxed: false },
    });
    // a person raises them again
    const back = await root({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { sandboxTiers: { max: null, default: null, allowUnsandboxed: null } },
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it("admin.update-settings: theme.not_available says the default must be on in every org", () => {
    const next = op("admin.update-settings").errors?.find(
      (e) => e.code === "theme.not_available",
    )?.next;
    expect(next).toMatch(/on in every organization/);
    expect(next).toMatch(/details list orgs/);
  });

  it("admin.update-settings: deployment.setting_readonly names the startup config, not a sandbox setting", () => {
    const next = op("admin.update-settings").errors?.find(
      (e) => e.code === "deployment.setting_readonly",
    )?.next;
    expect(next).toMatch(/startup config/);
    expect(next).toMatch(/admin\.settings shows the field's source/);
    expect(next).not.toMatch(/sandbox/);
  });

  it("lists the providers, then one provider's models; disables one platform-wide", async () => {
    const providers = (await run("models.platform-list", {})) as {
      items: { id: string; state: string; models: number }[];
    };
    expect(providers.items).toContainEqual(
      expect.objectContaining({ id: "model-fake", state: "ok" }),
    );
    const models = (await run("models.platform-list", { provider: "model-fake" })) as {
      items: { id: string; disabled: boolean }[];
    };
    expect(models.items).toContainEqual(expect.objectContaining({ id: "fake-1", disabled: false }));
    expect(
      await precheck("models.set-platform-disabled", { provider: "nope", disable: ["x"] }),
    ).toMatchObject({ ok: false, code: "model.provider_not_found" });
    await run("models.set-platform-disabled", { provider: "model-fake", disable: ["fake-1"] });
    expect(await auditOf("model.disabled_set", "models.set-platform-disabled")).toMatchObject({
      disabled: ["fake-1"],
      via: "agent",
    });
    await run("models.set-platform-disabled", { provider: "model-fake", enable: ["fake-1"] });
  });

  it("sets and reads a model price", async () => {
    const price = {
      provider: "model-fake",
      model: "fake-1",
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    };
    expect(await run("models.set-price", price)).toMatchObject({ price, currency: "USD" });
    const list = (await run("models.prices", {})) as { items: unknown[] };
    expect(list.items).toContainEqual(price);
    expect(await auditOf("model_price.updated", "models.set-price")).toMatchObject({
      via: "agent",
    });
  });

  it("sets the platform default of a purpose; an unknown purpose is refused before the card", async () => {
    expect(
      await precheck("models.set-platform-purpose", { purpose: "nope", target: null }),
    ).toMatchObject({ ok: false, code: "model.purpose_unknown" });
    const target = { model: { provider: "model-fake", model: "fake-1" } };
    expect(await precheck("models.set-platform-purpose", { purpose: "title", target })).toEqual({
      ok: true,
    });
    await run("models.set-platform-purpose", { purpose: "title", target });
    const list = (await run("models.platform-purposes", {})) as {
      items: { id: string; default: string | null }[];
    };
    expect(list.items).toContainEqual(
      expect.objectContaining({ id: "title", default: "model-fake/fake-1" }),
    );
    expect(await auditOf("model.purpose_mapped", "models.set-platform-purpose")).toMatchObject({
      via: "agent",
    });
  });
});
