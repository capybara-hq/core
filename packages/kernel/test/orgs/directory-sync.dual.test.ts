import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeChannelServer,
  type Harness,
  fakeDirectoryMember as person,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * 双副本：两个副本几乎同时各收到一次手动同步（两个不同的 job id），同一 (组织, 插件) 同时只跑一轮同步——
 * 后到的任务在锁被占时记下脏标记后结束；持有者跑完后取走标记补一轮（changed），成员只加入一次。
 */

const DIR_MINI = fileURLToPath(new URL("../fixtures/plugins/dir-mini/index.ts", import.meta.url));

let pgc: TestContainer;
let rdc: TestContainer;
let fd: FakeChannelServer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;
let queue: Queue | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  fd = await startFakeChannelServer();
}, 120_000);

afterAll(async () => {
  await queue?.close();
  await raw?.destroy();
  await h?.stop();
  await fd?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("通讯录同步（双副本）", () => {
  it("两个副本同时触发：同时只跑一轮，被锁挡掉的那次在持有者跑完后补一轮", async () => {
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, DIR_MINI],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    raw = createDb(harness.dbUrl, 3);
    const db: KernelDb = kernelDb(raw);
    queue = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection: new Redis(rdc.url, { maxRetriesPerRequest: null }),
    });

    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await harness.request(path, {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (path === "/api/v1/auth/login") {
        cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
      }
      return {
        status: res.status,
        replica: res.replica,
        json: (text === "" ? {} : JSON.parse(text)) as Json,
      };
    };

    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    expect(
      (await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
    const orgId = (org.json.org as { id: string }).id;
    const book = fd.book("dual");
    book.members = [person("d-1"), person("d-2")];
    let release = () => {};
    book.hold = new Promise<void>((r) => {
      release = r;
    });
    const en = await call("PUT", `/api/v1/orgs/${orgId}/plugins/dir-mini`, {
      enabled: true,
      config: { url: book.url },
    });
    expect(en.status).toBe(200);

    const path = `/api/v1/orgs/${orgId}/plugins/dir-mini/directory/sync`;
    const a = await call("POST", path);
    const b = await call("POST", path);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(new Set([a.replica, b.replica])).toEqual(new Set([0, 1]));
    const ids = [a.json.jobId as string, b.json.jobId as string];
    expect(ids[0]).not.toBe(ids[1]);

    // 第一轮挂在第一页（持有锁）期间，另一个任务执行完毕且没有开始第二轮
    await waitFor(async () => book.starts() === 1, 15_000, "first sync started");
    const completed = async (id: string) => (await queue?.getJobState(id)) === "completed";
    const other = await waitFor(
      async () => {
        for (const id of ids) if (await completed(id)) return id;
        return undefined;
      },
      15_000,
      "second job finished while the first holds the lock",
    );
    expect(other).toBeDefined();
    expect(book.starts()).toBe(1);

    release();
    await waitFor(
      async () => (await completed(ids[0] as string)) && (await completed(ids[1] as string)),
      15_000,
      "both jobs completed",
    );
    // 被锁挡掉的那次记了脏标记：持有者跑完后补一轮（changed），而且只补一轮
    const syncedRows = () =>
      db
        .selectFrom("audit_events")
        .select("detail")
        .where("org_id", "=", orgId)
        .where("action", "=", "org.directory.synced")
        .orderBy("id")
        .execute();
    const synced = await waitFor(
      async () => {
        const rows = await syncedRows();
        return rows.length === 2 ? rows : undefined;
      },
      15_000,
      "rerun after lock contention",
    );
    expect(synced[0]?.detail).toMatchObject({ trigger: "manual", added: 2, partial: false });
    expect(synced[1]?.detail).toMatchObject({ trigger: "changed", added: 0, partial: false });
    await sleep(500);
    expect(book.starts()).toBe(2);
    expect(await syncedRows()).toHaveLength(2);
    const rows = await db
      .selectFrom("memberships")
      .select("source")
      .where("org_id", "=", orgId)
      .where("source", "=", "directory:dir-mini")
      .execute();
    expect(rows).toHaveLength(2);
  }, 90_000);
});
