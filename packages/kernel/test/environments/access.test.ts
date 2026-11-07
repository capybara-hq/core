import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EnvironmentAccess } from "../../src/environments/access.js";
import {
  EnvironmentsService,
  type EnvironmentView,
} from "../../src/environments/environments.service.js";
import type { ApiError } from "../../src/errors.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
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
});
