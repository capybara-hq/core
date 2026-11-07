import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EnvironmentsService } from "../../src/environments/environments.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
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

/** `EnvironmentsService.setImDefault`: only the person's own live environment in the org. */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

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
  root = await mkdtemp(join(tmpdir(), "cap-env-imdef-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
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

async function newEnvironment(req: Req, org: string, name: string): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${org}/environments`,
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { environment: { id: string } }).environment.id;
}

const rows = (org: string, account: string) =>
  db
    .selectFrom("environment_defaults")
    .selectAll()
    .where("org_id", "=", org)
    .where("account_id", "=", account)
    .execute();

describe("setImDefault", () => {
  const service = () => k.app.get(EnvironmentsService);

  it("sets the person's own live environment", async () => {
    const id = await newEnvironment(owner, orgId, "Mine");
    await service().setImDefault(orgId, ownerId, id);
    expect(await service().imDefault(orgId, ownerId)).toBe(id);
    await db.deleteFrom("environment_defaults").where("account_id", "=", ownerId).execute();
  });

  it("rejects another person's environment", async () => {
    const login = `m-${randomUUID().slice(0, 8)}`;
    const other = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
      .id;
    await testMembers(db).add(orgId, other, "member", ownerId);
    const theirs = await newEnvironment(await session(k, login), orgId, "Theirs");
    await expect(service().setImDefault(orgId, ownerId, theirs)).rejects.toMatchObject({
      code: "environment.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
  });

  it("rejects a deleted environment", async () => {
    const id = await newEnvironment(owner, orgId, "Doomed");
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}/environments/${id}` });
    expect(del.statusCode, del.body).toBeLessThan(300);
    await expect(service().setImDefault(orgId, ownerId, id)).rejects.toMatchObject({
      code: "environment.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
  });

  it("rejects an environment of another org", async () => {
    const otherOrg = await createOrg(owner, "Other");
    const elsewhere = await newEnvironment(owner, otherOrg, "Elsewhere");
    await expect(service().setImDefault(orgId, ownerId, elsewhere)).rejects.toMatchObject({
      code: "environment.not_found",
    });
    expect(await rows(orgId, ownerId)).toHaveLength(0);
    expect(await rows(otherOrg, ownerId)).toHaveLength(0);
  });
});
