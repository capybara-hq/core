import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientAccess } from "../../src/client/client-access.service.js";
import { ClientReportsCron } from "../../src/client/client-reports.cron.js";
import { ClientReports } from "../../src/client/client-reports.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";

/**
 * The daily prune of client reports (plan Task 11): rows last seen more than 30 days ago go, once
 * per tick across replicas. Two cron hosts (two replicas' worth) share one PostgreSQL and one
 * Redis and fire the same tick at once: exactly one runs a delete statement.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
const redises: Redis[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await Promise.all(redises.splice(0).map((r) => r.quit()));
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
}, 120_000);

const row = (plugin: string, ageDays: number) => ({
  plugin,
  build: "a".repeat(64),
  org_id: null,
  contribution: null,
  kind: "load" as const,
  last_message: "m",
  first_at: new Date(Date.now() - ageDays * 86_400_000),
  last_at: new Date(Date.now() - ageDays * 86_400_000),
});

describe("client reports prune", { timeout: 120_000 }, () => {
  it("rows older than 30 days are deleted once per tick across two replicas", async () => {
    await db
      .insertInto("extension_client_reports")
      .values([row("old-one", 31), row("old-two", 45), row("fresh", 29), row("new", 0)])
      .execute();
    const log = createLogger("error", { write: () => {} });
    const deletes: number[] = [];
    const host = () => {
      const redis = new Redis(rd.url);
      redises.push(redis);
      // the service wraps one delete statement; count it per replica (prune never asks access)
      const tx = new TransactionHost(raw, log);
      const service = new ClientReports(new KernelDb(raw, tx), tx, {} as ClientAccess);
      const prune = service.prune.bind(service);
      service.prune = async () => {
        const n = await prune();
        deletes.push(n);
        return n;
      };
      return new ClientReportsCron(service, new LockService(redis, log), log);
    };
    const a = host();
    const b = host();
    await Promise.all([a.prune(), b.prune()]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toBe(2);
    const left = (await db.selectFrom("extension_client_reports").select("plugin").execute())
      .map((r) => r.plugin)
      .sort();
    expect(left).toEqual(["fresh", "new"]);
  });
});
