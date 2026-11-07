import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { EnvironmentView } from "../../src/environments/environments.service.js";
import { ApiError } from "../../src/errors.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { fakeFileSystems, removeFakeFileSystem } from "../fixtures/plugins/sandbox-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The environments API (spec 2026-11-07-environments-design §4.2 items 7, 12, 13; §9): personal
 * cloud environments, visible and usable only by their owner, on one kernel (api + worker) with
 * the fake sandbox.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

const MAX = 4;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let sandbox: SandboxService;
let ownerId: string;
let owner: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-env-http-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [fixture("sandbox-fake")],
        extensionConfig: { "sandbox-fake": { root } },
        environments: { maxPersonal: MAX },
      },
    ),
  );
  sandbox = k.app.get(SandboxService);
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

const base = () => `/api/v1/orgs/${orgId}/environments`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A new member of the org with a session. */
async function member(): Promise<{ id: string; req: Req }> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  await testMembers(db).add(orgId, id, "member", ownerId);
  return { id, req: await session(k, login) };
}

type List = {
  items: EnvironmentView[];
  defaultId: string | null;
  lastUsedId: string | null;
  cloudAvailable: boolean;
};

async function list(req: Req): Promise<List> {
  const res = await req({ method: "GET", url: base() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as List;
}

async function create(req: Req, name: string): Promise<EnvironmentView> {
  const res = await req({ method: "POST", url: base(), payload: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { environment: EnvironmentView }).environment;
}

const ctl = () => AbortSignal.timeout(30_000);

describe("environments API", () => {
  it("create, list, rename, delete a personal environment", async () => {
    const m = await member();
    const env = await create(m.req, "  Repo  ");
    expect(env).toMatchObject({
      name: "Repo",
      isDefault: false,
      ownerKind: "personal",
      source: "cloud",
      provider: "sandbox-fake",
      available: true,
      sessionIsolation: false,
      filesLost: false,
      instance: null,
      limits: { egress: expect.any(String), allowHosts: expect.any(Array) },
    });
    expect(typeof env.createdAt).toBe("string");

    const l = await list(m.req);
    expect(l.cloudAvailable).toBe(true);
    // the default is made on first need and listed first
    expect(l.items.map((e) => [e.name, e.isDefault])).toEqual([
      [null, true],
      ["Repo", false],
    ]);
    expect(l.defaultId).toBe(l.items[0]?.id);

    const got = await m.req({ method: "GET", url: `${base()}/${env.id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { environment: EnvironmentView }).environment.id).toBe(env.id);

    const renamed = await m.req({
      method: "PATCH",
      url: `${base()}/${env.id}`,
      payload: { name: "Repo 2" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.json() as { environment: EnvironmentView }).environment.name).toBe("Repo 2");

    const del = await m.req({ method: "DELETE", url: `${base()}/${env.id}` });
    expect(del.statusCode, del.body).toBe(202);
    const after = await m.req({ method: "GET", url: `${base()}/${env.id}` });
    expect(after.statusCode).toBe(404);
    expect(errCode(after)).toBe("environment.not_found");
    expect((await list(m.req)).items.map((e) => e.id)).not.toContain(env.id);
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", env.id)
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      "environment.created",
      "environment.renamed",
      "environment.deleted",
    ]);
  });

  it("validation, auth and service tokens", async () => {
    for (const name of ["", "   ", "x".repeat(65)]) {
      const res = await owner({ method: "POST", url: base(), payload: { name } });
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const extra = await owner({ method: "POST", url: base(), payload: { name: "a", x: 1 } });
    expect(extra.statusCode).toBe(400);

    const anon = await k.http.inject({ method: "GET", url: base() });
    expect(anon.statusCode).toBe(401);

    const outsider = `out-${randomUUID().slice(0, 8)}`;
    await accountsFor(db).createLocal({ login: outsider, password: PW, displayName: "X" });
    const notMember = await (await session(k, outsider))({ method: "GET", url: base() });
    expect(notMember.statusCode).toBe(404);
    expect(errCode(notMember)).toBe("org.not_found");

    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    for (const [method, payload] of [
      ["GET", undefined],
      ["POST", { name: "Bot" }],
    ] as const) {
      const res = await k.http.inject({
        method,
        url: base(),
        headers: { authorization: `Bearer ${token}` },
        ...(payload && { payload }),
      });
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe("forbidden");
    }
  });

  it("another member gets not_found for my environment", async () => {
    const me = await member();
    const other = await member();
    const env = await create(me.req, "Mine");
    for (const [method, url, payload] of [
      ["GET", `${base()}/${env.id}`, undefined],
      ["PATCH", `${base()}/${env.id}`, { name: "Theirs" }],
      ["DELETE", `${base()}/${env.id}`, undefined],
      ["POST", `${base()}/${env.id}/files/reset`, undefined],
    ] as const) {
      const res = await other.req({ method, url, ...(payload && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errCode(res)).toBe("environment.not_found");
    }
    expect((await list(other.req)).items.map((e) => e.id)).not.toContain(env.id);
    // untouched
    const mine = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((mine.json() as { environment: EnvironmentView }).environment.name).toBe("Mine");
    // and not usable by them through the sandbox either
    const err = await sandbox
      .withSandbox(
        {
          orgId: randomUUID(),
          environmentId: env.id,
          holderConversationId: randomUUID(),
          actor: { accountId: other.id, conversationId: randomUUID() },
        },
        async () => "ran",
        ctl(),
      )
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("environment.not_found");
  });

  it("names are unique per person, case-insensitive", async () => {
    const me = await member();
    const other = await member();
    const a = await create(me.req, "Build");
    const clash = await me.req({ method: "POST", url: base(), payload: { name: "build" } });
    expect(clash.statusCode).toBe(409);
    expect(errCode(clash)).toBe("environment.name_taken");
    // another person may use the same name
    await create(other.req, "BUILD");
    // renaming onto another of my names is refused; a case change of its own name is not
    const b = await create(me.req, "Test");
    const onto = await me.req({
      method: "PATCH",
      url: `${base()}/${b.id}`,
      payload: { name: "BUILD" },
    });
    expect(onto.statusCode).toBe(409);
    expect(errCode(onto)).toBe("environment.name_taken");
    const recase = await me.req({
      method: "PATCH",
      url: `${base()}/${a.id}`,
      payload: { name: "BUILD" },
    });
    expect(recase.statusCode, recase.body).toBe(200);
    // a deleted environment's name is free again
    expect((await me.req({ method: "DELETE", url: `${base()}/${b.id}` })).statusCode).toBe(202);
    await create(me.req, "test");
  });

  it("limit_reached at maxPersonal", async () => {
    const me = await member();
    await list(me.req); // makes the default, which counts
    for (let i = 1; i < MAX; i++) await create(me.req, `env-${i}`);
    const over = await me.req({ method: "POST", url: base(), payload: { name: "one more" } });
    expect(over.statusCode).toBe(409);
    expect(errCode(over)).toBe("environment.limit_reached");
    const items = (await list(me.req)).items;
    expect(items).toHaveLength(MAX);
    // deleting one frees a place
    const last = items[items.length - 1] as EnvironmentView;
    expect((await me.req({ method: "DELETE", url: `${base()}/${last.id}` })).statusCode).toBe(202);
    await create(me.req, "one more");
  });

  it("list reports defaultId and lastUsedId", async () => {
    const me = await member();
    const first = await list(me.req);
    expect(first.lastUsedId).toBeNull();
    expect(first.defaultId).not.toBeNull();
    const again = await list(me.req);
    expect(again.defaultId).toBe(first.defaultId);
    expect(again.items.filter((e) => e.isDefault)).toHaveLength(1);

    const a = await create(me.req, "A");
    const b = await create(me.req, "B");
    const agentId = randomUUID();
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${me.id}, 'org', 1)`.execute(raw);
    const conv = async (environmentId: string | null, updatedAt: string, accountId = me.id) =>
      sql`INSERT INTO capybara.conversations
          (id, org_id, agent_id, account_id, environment_id, updated_at)
        VALUES (${randomUUID()}, ${orgId}, ${agentId}, ${accountId}, ${environmentId},
          ${updatedAt}::timestamptz)`.execute(raw);
    await conv(a.id, "2026-01-01T00:00:00Z");
    await conv(b.id, "2026-02-01T00:00:00Z");
    // newer, but without an environment
    await conv(null, "2026-03-01T00:00:00Z");
    // another person's newer conversation does not count
    const other = await member();
    const theirs = await create(other.req, "Theirs");
    await conv(theirs.id, "2026-04-01T00:00:00Z", other.id);
    expect((await list(me.req)).lastUsedId).toBe(b.id);
    // a deleted environment is not the last used one
    expect((await me.req({ method: "DELETE", url: `${base()}/${b.id}` })).statusCode).toBe(202);
    expect((await list(me.req)).lastUsedId).toBe(a.id);
  });

  it("delete waits for running commands then destroys both", { timeout: 60_000 }, async () => {
    const me = await member();
    const env = await create(me.req, "Busy");
    const conversationId = randomUUID();
    const at = {
      orgId,
      environmentId: env.id,
      holderConversationId: conversationId,
      actor: { accountId: me.id, conversationId },
    };
    // a command holding a shared lease
    const running = sandbox.withSandbox(
      at,
      (h, p, _info, signal) =>
        p.exec(h, {
          command: "touch /workspace/started && sleep 1.5 && echo done",
          timeoutMs: 20_000,
          maxOutputBytes: 1000,
          signal,
        }),
      ctl(),
    );
    const started = await waitFor(
      async () => {
        for (const fs of await fakeFileSystems(root)) {
          if (existsSync(join(root, "filesystems", fs, "workspace", "started"))) return fs;
        }
        return null;
      },
      15_000,
      "the command to start",
    );
    const del = await me.req({ method: "DELETE", url: `${base()}/${env.id}` });
    expect(del.statusCode, del.body).toBe(202);
    // the command finishes: the destruction waited for it
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
    await waitFor(
      async () =>
        !(await db
          .selectFrom("environment_instances")
          .select("environment_id")
          .where("environment_id", "=", env.id)
          .executeTakeFirst()),
      20_000,
      "the instance row to go",
    );
    expect(await fakeFileSystems(root)).not.toContain(started);
    const instances = await readdir(join(root, "instances")).catch(() => [] as string[]);
    expect(instances).toEqual([]);
    // a later use in that conversation finds no environment
    const err = await sandbox.withSandbox(at, async () => "ran", ctl()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("environment.not_found");
  });

  it("reset files after files_lost", { timeout: 60_000 }, async () => {
    const me = await member();
    const env = await create(me.req, "Fragile");
    const conversationId = randomUUID();
    const at = {
      orgId,
      environmentId: env.id,
      holderConversationId: conversationId,
      actor: { accountId: me.id, conversationId },
    };
    const write = (body: string) =>
      sandbox.withSandbox(
        at,
        (h, p, _i, sig) => p.writeFile(h, "/workspace/f.txt", new TextEncoder().encode(body), sig),
        ctl(),
      );
    const before = new Set(await fakeFileSystems(root));
    await write("one");
    const fsId = (await fakeFileSystems(root)).find((f) => !before.has(f)) as string;
    expect(fsId).toBeDefined();
    // the instance goes away (inactivity) and the files are lost at the provider
    await sql`UPDATE capybara.environment_instances SET status = 'destroyed', handle = NULL
      WHERE environment_id = ${env.id}`.execute(raw);
    await removeFakeFileSystem(root, fsId);
    const lost = await write("two").catch((e: unknown) => e);
    expect((lost as ApiError).code).toBe("environment.files_lost");
    const view = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((view.json() as { environment: EnvironmentView }).environment.filesLost).toBe(true);

    const reset = await me.req({ method: "POST", url: `${base()}/${env.id}/files/reset` });
    expect(reset.statusCode, reset.body).toBe(202);
    const fresh = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((fresh.json() as { environment: EnvironmentView }).environment.filesLost).toBe(false);
    await write("three");
    const read = await sandbox.withSandbox(
      at,
      (h, p, _i, sig) => p.readFile(h, "/workspace/f.txt", { maxBytes: 100, signal: sig }),
      ctl(),
    );
    expect(new TextDecoder().decode(read?.data)).toBe("three");
    const running = await me.req({ method: "GET", url: `${base()}/${env.id}` });
    expect((running.json() as { environment: EnvironmentView }).environment.instance).toMatchObject(
      { status: "running", lastUsedAt: expect.any(String) },
    );
  });
});
