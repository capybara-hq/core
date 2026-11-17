import { randomUUID } from "node:crypto";
import {
  createDb,
  createLogger,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  kernelDb,
  loadConfig,
  migrate,
  openKernelCli,
  PermissionAuthorityModule,
  PermissionConfigPublication,
} from "@capybara-hq/kernel";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, runCliInProcess } from "./support/cli.js";

/**
 * `capybara permissions cutover report | freeze | snapshot` (permission runtime cutover B-10,
 * B-26). The report and the freeze run without Redis; the snapshot refuses before the freeze and
 * snapshots every cloud device after it (a rerun publishes nothing). The cases share one database
 * and run in order.
 */
let pg: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

/** The CLI's environment; `redis: false` points Redis at a closed port. */
function env(o: { redis?: boolean } = {}): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: o.redis === false ? "redis://127.0.0.1:1" : rd.url,
    CAPYBARA_MASTER_KEY: MASTER_KEY,
  };
}

let cloudDevice: string;
let localDevice: string;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR });
  raw = createDb(pg.url, 2);
  // the deployment's published permission configuration: the one this CLI's config resolves to
  const app = await openKernelCli(await loadConfig(env()), {
    logger: createLogger("error", { write: () => {} }),
    modules: [PermissionAuthorityModule],
    redis: false,
  });
  try {
    await app.get(PermissionConfigPublication).initialize();
  } finally {
    await app.close();
  }
  const db = kernelDb(raw);
  const accountId = randomUUID(),
    orgId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID();
  cloudDevice = randomUUID();
  localDevice = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "Op", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({ id: orgId, slug: orgId, name: "Op", created_by: accountId, settings: "{}" })
    .execute();
  await db
    .insertInto("agents")
    .values({
      id: agentId,
      org_id: orgId,
      owner_account_id: accountId,
      visibility: "org",
      current_version: 1,
    })
    .execute();
  for (const [id, source] of [
    [cloudDevice, "cloud"],
    [localDevice, "local"],
  ] as const)
    await db
      .insertInto("devices")
      .values({
        id,
        org_id: orgId,
        owner_kind: "personal",
        owner_account_id: accountId,
        source,
        provider: source === "cloud" ? "sandbox-fake" : null,
      })
      .execute();
  await db
    .insertInto("conversations")
    .values({
      id: conversationId,
      org_id: orgId,
      account_id: accountId,
      agent_id: agentId,
      title: null,
      source: "web",
      device_id: localDevice,
    })
    .execute();
  // a legacy SID task on the local device, whose computer never reported a boot identity
  await db
    .insertInto("background_tasks")
    .values({
      id: "bt_aaaaaa",
      org_id: orgId,
      conversation_id: conversationId,
      sandbox_conversation_id: conversationId,
      device_id: localDevice,
      run_id: "run-1",
      call_id: "call-1",
      trigger_account_id: accountId,
      description: "d",
      command: "sleep 600",
      sid: "4242",
      output_path: "/workspace/.capybara/tasks/bt_aaaaaa.out",
      status: "running",
      deadline_at: new Date(Date.now() + 3600_000),
      sandbox_created_at: new Date(),
    })
    .execute();
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});

describe("capybara permissions cutover", () => {
  it("report runs without Redis and shows the pre-checks (--json)", async () => {
    const r = await runCliInProcess(
      ["permissions", "cutover", "report", "--json"],
      env({ redis: false }),
    );
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({
      configCurrent: true,
      replicas: null,
      retirement: {
        frozen: false,
        frozenAt: null,
        localWithoutBoot: [{ deviceId: localDevice, machineId: null }],
        cloudUnknown: [],
        open: 0,
        quarantined: 0,
        unfencedWriters: { sinceMigration: 1, afterFreeze: 0 },
      },
      snapshot: { cloudDevices: 1, pending: 1, reconcileRequired: [] },
    });
  }, 60_000);

  it("report in human form names the waits and the next step", async () => {
    const r = await runCliInProcess(["permissions", "cutover", "report"], env({ redis: false }));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Legacy freeze: not published");
    expect(r.stdout).toContain("Replicas: unknown (Redis did not answer)");
    expect(r.stdout).toContain(`Local devices without a boot identity: 1`);
    expect(r.stdout).toContain(localDevice);
    expect(r.stdout).toContain("Next:");
  }, 60_000);

  it("snapshot refuses while legacy admission is open (no freeze)", async () => {
    const r = await runCliInProcess(["permissions", "cutover", "snapshot"], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/freeze/);
    const row = await kernelDb(raw)
      .selectFrom("devices")
      .select("owner_full_access")
      .where("id", "=", cloudDevice)
      .executeTakeFirstOrThrow();
    expect(row.owner_full_access).toBeNull();
  }, 60_000);

  it("freeze runs without Redis, enumerates before it returns and is idempotent", async () => {
    const r = await runCliInProcess(
      ["permissions", "cutover", "freeze", "--json"],
      env({ redis: false }),
    );
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      freeze: { added: 1, stable: true },
      report: { retirement: { frozen: true, open: 1 } },
    });
    expect(out.report.retirement.freezeEnumeratedAt).not.toBeNull();
    const again = await runCliInProcess(
      ["permissions", "cutover", "freeze"],
      env({ redis: false }),
    );
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Legacy freeze: published");
    expect(again.stdout).toContain(`enumerated 0 new members`);
  }, 60_000);

  it("snapshot snapshots every cloud device after the freeze; a rerun publishes nothing", async () => {
    const r = await runCliInProcess(["permissions", "cutover", "snapshot", "--json"], env());
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      results: [{ deviceId: cloudDevice, state: "unprobed" }],
      failed: [],
      pending: 0,
      reconcileRequired: [],
    });
    const rerun = await runCliInProcess(["permissions", "cutover", "snapshot"], env());
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain("Snapshotted 0 cloud device(s)");
    expect(rerun.stdout).toContain("pending 0");
  }, 60_000);

  it("rejects an unknown cutover action and --json elsewhere (usage error)", async () => {
    expect((await runCliInProcess(["permissions", "cutover", "thaw"], env())).code).toBe(2);
    expect((await runCliInProcess(["permissions", "freeze"], env())).code).toBe(2);
    expect((await runCliInProcess(["migrate", "--json"], env())).code).toBe(2);
  }, 60_000);
});
