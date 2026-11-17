import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceProjectsService } from "../../src/devices/device-projects.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { RunExecution, withExclusiveAdmission } from "../../src/runtime/run-execution.js";
import {
  type AuthoritySubject,
  PermissionAuthorityLock,
  PermissionLockOrderError,
} from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import { startRun } from "../runtime/permission-context-fixture.js";

// The ceiling writers a Platform operation reaches from a tool step take their permission authority
// write lock in the ordered prelude: after the run fence's org row, before its conversation rows.
// Each case: a reader that holds the shared authority locks of tree X and then wants X's root row
// (the order every prelude-first transaction takes) against a writer called inside a claimed run of
// tree X. Locked after the fence's root row, the writer waits for the reader's shared lock while the
// reader waits for the writer's root row: 40P01 (or, with the stricter guard, a refusal). In the
// prelude the writer waits before it holds the root row, so both commit.

let pg: TestContainer, redis: TestContainer, k: TestKernel;
// biome-ignore lint/suspicious/noExplicitAny: the test pool carries no schema types
let raw: Kysely<any>;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(() => {
  vi.restoreAllMocks();
});

/** A service's private method, spied on as a test seam. */
// biome-ignore lint/suspicious/noExplicitAny: private methods carry no public type
const seam = (service: object) => service as Record<string, (...args: any[]) => Promise<any>>;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** An org whose owner (a super admin) runs a claimed run in tree X, with a cloud device. */
async function seed() {
  const s = await seedConversation(raw);
  const db = kernelDb(raw);
  await db
    .insertInto("memberships")
    .values({ org_id: s.orgId, account_id: s.accountId, role: "owner" })
    .execute();
  await db
    .updateTable("accounts")
    .set({ is_super_admin: true })
    .where("id", "=", s.accountId)
    .execute();
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: s.orgId,
      owner_kind: "personal",
      owner_account_id: s.accountId,
      source: "cloud",
      provider: "@cloud",
      name: "Box",
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", s.conversationId)
    .execute();
  const run = await startRun(k, raw, s.conversationId, s.accountId);
  return { ...s, db, deviceId, rootId: s.conversationId, ...run };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const waitingLocks = async (): Promise<number> =>
  Number(
    (
      await sql<{ n: string }>`select count(*) n from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where not l.granted and a.datname = current_database()`.execute(raw)
    ).rows[0]?.n,
  );

/**
 * A prelude-first reader (an approval job, a review): the shared authority locks of `subject`,
 * paused, then tree X's root row.
 */
function reader(subject: AuthoritySubject, rootId: string) {
  const held = deferred();
  const go = deferred();
  const done = k.app.get(TransactionHost).run(async () => {
    await k.app.get(PermissionAuthorityLock).acquire(subject, { kind: "admit" });
    held.resolve();
    await go.promise;
    await k.app
      .get(KernelDb)
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", rootId)
      .forNoKeyUpdate()
      .execute();
  });
  return { held: held.promise, go: go.resolve, done };
}

/** Runs `write` as a tool step of the claimed run against the reader; both must commit. */
async function againstReader(
  f: Fixture,
  subject: AuthoritySubject,
  write: () => Promise<unknown>,
): Promise<void> {
  const r = reader(subject, f.rootId);
  await r.held;
  let settled = false;
  const op = k.app
    .get(RunExecution)
    .withClaim(
      f.claim,
      () => true,
      () => withExclusiveAdmission(write),
    )
    .finally(() => {
      settled = true;
    });
  // the writer waits for the reader's shared lock (or, on the old order, has been refused)
  await expect.poll(async () => settled || (await waitingLocks()) > 0).toBe(true);
  r.go();
  const [a, b] = await Promise.allSettled([op, r.done]);
  expect(a.status === "rejected" ? String(a.reason) : "fulfilled").toBe("fulfilled");
  expect(b.status === "rejected" ? String(b.reason) : "fulfilled").toBe("fulfilled");
}

const treeSubject = (f: Fixture, device = false): AuthoritySubject => ({
  orgId: f.orgId,
  ...(device && { deviceId: f.deviceId }),
  rootConversationId: f.rootId,
});

describe("ceiling writers reached from a tool step lock in the ordered prelude", () => {
  it("devices.delete: the device write lock precedes the run's root row", async () => {
    const f = await seed();
    await againstReader(f, treeSubject(f, true), () =>
      k.app.get(DevicesService).remove(f.orgId, f.accountId, f.deviceId),
    );
    const row = await f.db
      .selectFrom("devices")
      .select("deleted_at")
      .where("id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });

  it("devices.add-project: the device write lock precedes the run's root row", async () => {
    const f = await seed();
    const projects = k.app.get(DeviceProjectsService);
    // the device is not asked (no sandbox in this test): the insert is what is ordered
    vi.spyOn(seam(projects), "precheck").mockResolvedValue({
      source: "cloud",
      reach: "workspace",
      mode: "sandbox",
      workspace: "/work",
      home: "/home/u",
      supported: true,
    } as never);
    vi.spyOn(seam(projects), "onDevice").mockResolvedValue({
      path: "/work/p",
      name: "p",
    } as never);
    await againstReader(f, treeSubject(f, true), () =>
      projects.add(f.orgId, f.accountId, f.deviceId, { path: "p" }),
    );
    expect(
      await f.db
        .selectFrom("device_projects")
        .select("name")
        .where("device_id", "=", f.deviceId)
        .execute(),
    ).toEqual([{ name: "p" }]);
  });

  it("devices.remove-project: the device write lock precedes the run's root row", async () => {
    const f = await seed();
    await f.db
      .insertInto("device_projects")
      .values({ device_id: f.deviceId, name: "p", path: "/work/p", created_by: f.accountId })
      .execute();
    await againstReader(f, treeSubject(f, true), () =>
      k.app.get(DeviceProjectsService).remove(f.orgId, f.accountId, f.deviceId, "p"),
    );
    expect(
      await f.db
        .selectFrom("device_projects")
        .select("name")
        .where("device_id", "=", f.deviceId)
        .execute(),
    ).toEqual([]);
  });

  it("org-settings.update narrowing Full: the org write lock precedes the run's root row", async () => {
    const f = await seed();
    await againstReader(f, treeSubject(f), () =>
      k.app
        .get(OrgSettingsService)
        .update(f.orgId, { fullAccess: "off" }, f.accountId, undefined, undefined, {
          onlyNarrows: true,
        }),
    );
    expect((await k.app.get(OrgSettingsService).get(f.orgId)).fullAccess).toBe("off");
  });

  it("accounts.disable: the platform write lock precedes the run's root row", async () => {
    const f = await seed();
    const target = randomUUID();
    await f.db.insertInto("accounts").values({ id: target, display_name: "T" }).execute();
    await againstReader(f, treeSubject(f), () =>
      k.app.get(AccountsService).updateAccount(target, { status: "disabled" }, f.accountId),
    );
    expect((await k.app.get(AccountsService).get(target))?.status).toBe("disabled");
  });

  it("admin.update-settings turning Full off: the platform write lock precedes the run's root row", async () => {
    const f = await seed();
    try {
      await againstReader(f, treeSubject(f), () =>
        k.app
          .get(SettingsService)
          .update({ devicesFullAccess: { permission: "off" } }, f.accountId, undefined, undefined, {
            onlyNarrows: true,
          }),
      );
      expect((await k.app.get(SettingsService).view()).devicesFullAccess).toMatchObject({
        permission: "off",
      });
    } finally {
      await f.db.deleteFrom("deployment_settings").where("key", "=", "devicesFullAccess").execute();
    }
  });
});

describe("re-checks under the prelude's locks", () => {
  it("an account status that changed after the prelude read it is a conflict, nothing written", async () => {
    const f = await seed();
    const target = randomUUID();
    await f.db
      .insertInto("accounts")
      .values({ id: target, display_name: "T", status: "disabled" })
      .execute();
    const accounts = k.app.get(AccountsService);
    type Prelude = (id: string, patch: object, actor: string) => Promise<boolean>;
    const real = (accounts as unknown as { lockForUpdate: Prelude }).lockForUpdate.bind(accounts);
    // the prelude sees the target disabled already (no change: no platform lock); another writer
    // enables it before the body re-reads it
    vi.spyOn(seam(accounts), "lockForUpdate").mockImplementation((async (
      id: string,
      patch: object,
      actor: string,
    ) => {
      const locked = await real(id, patch, actor);
      await raw
        .updateTable("capybara.accounts")
        .set({ status: "active" })
        .where("id", "=", target)
        .execute();
      return locked;
    }) as never);
    await expect(
      k.app.get(RunExecution).withClaim(
        f.claim,
        () => true,
        () =>
          withExclusiveAdmission(() =>
            accounts.updateAccount(target, { status: "disabled" }, f.accountId),
          ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await accounts.get(target))?.status).toBe("active");
  });
});

describe("conversation deletion re-checks its prelude's subject", () => {
  it("a device rebound after the prelude read it is a conflict, nothing deleted", async () => {
    const f = await seed();
    const other = randomUUID();
    await f.db
      .insertInto("devices")
      .values({
        id: other,
        org_id: f.orgId,
        owner_kind: "personal",
        owner_account_id: f.accountId,
        source: "cloud",
        provider: "@cloud",
        name: "Other",
      })
      .execute();
    const conversations = k.app.get(ConversationsService);
    type Subject = (orgId: string, id: string) => Promise<unknown>;
    const real = (conversations as unknown as { deletionSubject: Subject }).deletionSubject.bind(
      conversations,
    );
    let calls = 0;
    // the prelude's subject is read; the root is rebound to another device before the deletion
    // re-reads it under the locks
    vi.spyOn(seam(conversations), "deletionSubject").mockImplementation((async (
      orgId: string,
      id: string,
    ) => {
      const subject = await real(orgId, id);
      if (calls++ === 0)
        await raw
          .updateTable("capybara.conversations")
          .set({ device_id: other })
          .where("id", "=", f.rootId)
          .execute();
      return subject;
    }) as never);
    // the seeded agent has no version row (its view refuses); the owner check is not under test
    vi.spyOn(conversations, "writable").mockResolvedValue({} as never);
    await expect(conversations.remove(f.orgId, f.rootId, f.accountId)).rejects.toMatchObject({
      code: "conflict",
    });
    const row = await f.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", f.rootId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
  });
});

describe("the fenced lock order guard", () => {
  it("refuses a permission write lock taken after a fenced transaction's rows", async () => {
    const f = await seed();
    // a writer that skips the prelude: the fence's conversation rows are already held
    const err = await k.app
      .get(RunExecution)
      .withClaim(
        f.claim,
        () => true,
        () =>
          withExclusiveAdmission(() =>
            k.app
              .get(TransactionHost)
              .run(() =>
                k.app
                  .get(PermissionCeilingWrites)
                  .lock({ orgId: f.orgId, deviceId: f.deviceId }, "device"),
              ),
          ),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PermissionLockOrderError);
    expect((err as PermissionLockOrderError).keys).toEqual([
      "permission-authority-platform-platform",
      `permission-authority-org-${f.orgId}`,
      `permission-authority-device-${f.deviceId}`,
    ]);
  });

  it("an HTTP caller (no fence) keeps its order: the prelude runs first in its transaction", async () => {
    const f = await seed();
    // no run fence in context: the device write commits as before
    await k.app.get(DevicesService).remove(f.orgId, f.accountId, f.deviceId);
    const row = await f.db
      .selectFrom("devices")
      .select("deleted_at")
      .where("id", "=", f.deviceId)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
  });
});
