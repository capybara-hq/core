import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EnvironmentAccess } from "../../src/environments/access.js";
import { ConversationEnvironments } from "../../src/environments/conversation-environments.js";
import {
  EnvironmentsService,
  type EnvironmentView,
} from "../../src/environments/environments.service.js";
import type { ApiError } from "../../src/errors.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { legacyDbFor } from "../helpers/conversations.js";
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
 * Who may use an environment ({@link EnvironmentAccess}) and the default environment
 * ({@link EnvironmentsService.ensureDefault}), on a kernel with the fake sandbox.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-env-access-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fixture("sandbox-fake")],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e as ApiError).code,
  );

describe("environment access", () => {
  it("ensureDefault is idempotent under concurrency", async () => {
    const service = k.app.get(EnvironmentsService);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => service.ensureDefault(orgId, ownerId)),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await db
      .selectFrom("environments")
      .select(["id", "name", "provider"])
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", ownerId)
      .where("is_default", "=", true)
      .execute();
    expect(rows).toEqual([{ id: ids[0], name: null, provider: "sandbox-fake" }]);
    // a deleted default is replaced by a new one
    await sql`UPDATE capybara.environments SET deleted_at = now() WHERE id = ${ids[0]}`.execute(
      raw,
    );
    const next = await service.ensureDefault(orgId, ownerId);
    expect(next).not.toBe(ids[0]);
  });

  it("ensureDefault makes no default for someone who is not a member (any more)", async () => {
    const service = k.app.get(EnvironmentsService);
    const left = (
      await accountsFor(db).createLocal({
        login: `left-${randomUUID().slice(0, 8)}`,
        password: PW,
        displayName: "L",
      })
    ).id;
    expect(await codeOf(service.ensureDefault(orgId, left))).toBe("org.not_found");
    const rows = await db
      .selectFrom("environments")
      .select("id")
      .where("owner_account_id", "=", left)
      .execute();
    expect(rows).toEqual([]);
  });

  it("usable only by the owner in the environment's org", async () => {
    const access = k.app.get(EnvironmentAccess);
    const id = await k.app.get(EnvironmentsService).ensureDefault(orgId, ownerId);
    expect(await access.usable(orgId, ownerId, id)).toEqual({ id, provider: "sandbox-fake" });
    expect(await codeOf(access.usable(orgId, randomUUID(), id))).toBe("environment.not_found");
    expect(await codeOf(access.usable(randomUUID(), ownerId, id))).toBe("environment.not_found");
    expect(await codeOf(access.usable(orgId, ownerId, randomUUID()))).toBe("environment.not_found");
    await sql`UPDATE capybara.environments SET deleted_at = now() WHERE id = ${id}`.execute(raw);
    expect(await codeOf(access.usable(orgId, ownerId, id))).toBe("environment.not_found");
  });

  it("unavailable when the provider changed", async () => {
    const access = k.app.get(EnvironmentAccess);
    const id = await k.app.get(EnvironmentsService).ensureDefault(orgId, ownerId);
    // created under another provider, never used: the current provider takes it over
    await sql`UPDATE capybara.environments SET provider = 'sandbox-old' WHERE id = ${id}`.execute(
      raw,
    );
    expect(await access.usable(orgId, ownerId, id)).toEqual({ id, provider: "sandbox-fake" });
    // files kept by the old provider: unusable until it is back
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${id}, ${orgId}, 'sandbox-old', '{"id":"fs-old"}'::jsonb, 'ready')`.execute(raw);
    const err = await access.usable(orgId, ownerId, id).catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ code: "environment.unavailable", status: 503 });
    expect((err as ApiError).message).toContain("sandbox-old");

    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/environments/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { environment: EnvironmentView }).environment).toMatchObject({
      provider: "sandbox-old",
      available: false,
    });
    const reset = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/environments/${id}/files/reset`,
    });
    expect(reset.statusCode).toBe(503);
    expect((reset.json() as { error: { code: string } }).error.code).toBe(
      "environment.unavailable",
    );
  });

  it("a default stranded by a provider switch is demoted and replaced", async () => {
    const service = k.app.get(EnvironmentsService);
    const login = `sw-${randomUUID().slice(0, 8)}`;
    const me = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, me, "member", ownerId);
    const req = await session(k, login);
    const oldId = await service.ensureDefault(orgId, me);
    // its files are kept by the old provider; the deployment now runs sandbox-fake
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${oldId}, ${orgId}, 'sandbox-old', '{"id":"fs-old"}'::jsonb, 'ready')`.execute(raw);
    // a person-made environment named like the old generated name is left alone
    await sql`INSERT INTO capybara.environments
        (id, org_id, owner_kind, owner_account_id, name, source, provider)
      VALUES (${randomUUID()}, ${orgId}, 'personal', ${me}, 'Personal (sandbox-old)', 'cloud',
        'sandbox-fake')`.execute(raw);

    const ids = await Promise.all(
      Array.from({ length: 8 }, () => service.ensureDefault(orgId, me)),
    );
    expect(new Set(ids).size).toBe(1);
    const freshId = ids[0] as string;
    expect(freshId).not.toBe(oldId);

    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/environments` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: EnvironmentView[]; defaultId: string };
    expect(body.defaultId).toBe(freshId);
    expect(body.items.find((e) => e.id === freshId)).toMatchObject({
      isDefault: true,
      name: null,
      available: true,
    });
    expect(body.items.find((e) => e.id === oldId)).toMatchObject({
      isDefault: false,
      name: null,
      demotedFrom: { provider: "sandbox-old", displayName: null, ordinal: 1 },
      provider: "sandbox-old",
      available: false,
    });
    expect(body.items.find((e) => e.name === "Personal (sandbox-old)")).toMatchObject({
      demotedFrom: null,
    });
    // a new conversation without a choice gets the fresh default
    expect(await k.app.get(ConversationEnvironments).forNew(orgId, me)).toBe(freshId);
    // the demoted one can still be deleted
    const del = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/environments/${oldId}`,
    });
    expect(del.statusCode, del.body).toBe(202);
  });

  it("a default that never got resources is not stranded", async () => {
    const service = k.app.get(EnvironmentsService);
    const login = `nr-${randomUUID().slice(0, 8)}`;
    const me = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, me, "member", ownerId);
    const id = await service.ensureDefault(orgId, me);
    await sql`UPDATE capybara.environments SET provider = 'sandbox-old' WHERE id = ${id}`.execute(
      raw,
    );
    expect(await service.ensureDefault(orgId, me)).toBe(id);
  });

  it("switching the provider back restores the demoted default instead of making another", async () => {
    const service = k.app.get(EnvironmentsService);
    const providers = k.app.get(SandboxProviders);
    const login = `rs-${randomUUID().slice(0, 8)}`;
    const me = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
    await testMembers(db).add(orgId, me, "member", ownerId);
    const req = await session(k, login);
    const realCurrent = providers.current.bind(providers);
    const switchTo = (plugin: string | null) => {
      vi.restoreAllMocks();
      if (plugin === null) return;
      const impl = realCurrent()?.impl;
      if (!impl) throw new Error("no current provider");
      vi.spyOn(providers, "current").mockReturnValue({ plugin, impl });
    };
    const rows = () =>
      db
        .selectFrom("environments")
        .select(["id", "name", "is_default", "demoted_from_provider"])
        .where("org_id", "=", orgId)
        .where("owner_account_id", "=", me)
        .where("deleted_at", "is", null)
        .orderBy("created_at")
        .orderBy("id")
        .execute();

    // P1 (sandbox-fake): the default, whose files the provider keeps
    const d1 = await service.ensureDefault(orgId, me);
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${d1}, ${orgId}, 'sandbox-fake', '{"id":"fs-d1"}'::jsonb, 'ready')`.execute(raw);
    // a person-made environment named like a demoted default, with files at P1: never restored
    const named = await service.create(orgId, me, { name: "Personal (sandbox-fake)" });
    await sql`INSERT INTO capybara.environment_instances
        (environment_id, org_id, provider, fs_handle, fs_status)
      VALUES (${named.id}, ${orgId}, 'sandbox-fake', '{"id":"fs-n"}'::jsonb, 'ready')`.execute(raw);

    try {
      // P1 -> P2: d1 is demoted (marker, no name), a fresh default d2 is made
      switchTo("sandbox-other");
      const d2 = await service.ensureDefault(orgId, me);
      expect(d2).not.toBe(d1);
      expect(await rows()).toEqual([
        { id: d1, name: null, is_default: false, demoted_from_provider: "sandbox-fake" },
        {
          id: named.id,
          name: "Personal (sandbox-fake)",
          is_default: false,
          demoted_from_provider: null,
        },
        { id: d2, name: null, is_default: true, demoted_from_provider: null },
      ]);

      // P2 -> P1: d1 comes back (same row, same files), d2 is demoted; no new row
      switchTo(null);
      const back = await Promise.all(
        Array.from({ length: 8 }, () => service.ensureDefault(orgId, me)),
      );
      expect(new Set(back)).toEqual(new Set([d1]));
      expect(await rows()).toEqual([
        { id: d1, name: null, is_default: true, demoted_from_provider: null },
        {
          id: named.id,
          name: "Personal (sandbox-fake)",
          is_default: false,
          demoted_from_provider: null,
        },
        { id: d2, name: null, is_default: false, demoted_from_provider: "sandbox-other" },
      ]);
      const fs = await db
        .selectFrom("environment_instances")
        .select("fs_handle")
        .where("environment_id", "=", d1)
        .executeTakeFirstOrThrow();
      expect(fs.fs_handle).toEqual({ id: "fs-d1" });

      const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/environments` });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { items: EnvironmentView[]; defaultId: string };
      expect(body.defaultId).toBe(d1);
      expect(body.items.find((e) => e.id === d1)).toMatchObject({
        isDefault: true,
        name: null,
        demotedFrom: null,
        available: true,
      });
      expect(body.items.find((e) => e.id === d2)).toMatchObject({
        isDefault: false,
        name: null,
        demotedFrom: { provider: "sandbox-other", ordinal: 1 },
      });

      // and again: back and forth swaps the two rows, never adds one
      switchTo("sandbox-other");
      expect(await service.ensureDefault(orgId, me)).toBe(d2);
      switchTo(null);
      expect(await service.ensureDefault(orgId, me)).toBe(d1);
      expect((await rows()).length).toBe(3);

      // renaming a demoted default takes it over: it is no longer restorable
      await service.rename(orgId, me, d2, "Old E2B box");
      expect((await rows()).find((r) => r.id === d2)).toMatchObject({
        name: "Old E2B box",
        demoted_from_provider: null,
      });
      switchTo("sandbox-other");
      const d3 = await service.ensureDefault(orgId, me);
      expect([d1, d2, named.id]).not.toContain(d3);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
