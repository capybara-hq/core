import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AccountsService,
  createDb,
  createLogger,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  kernelDb,
  migrate,
  standaloneDatabase,
} from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PW = "correct horse battery";

let pg: TestContainer;
let raw: ReturnType<typeof createDb>;
let accounts: AccountsService;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR });
  raw = createDb(pg.url, 2);
  const h = standaloneDatabase(raw, createLogger("error"));
  accounts = new AccountsService(h.db, h.txHost, h.adminLock, h.setupLock);
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    enterpriseAdmin: true,
  });
  await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" });
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pg?.stop();
});

/** 测试库的环境变量：剥掉父进程的 CAPYBARA_*，Redis 给一个不可达地址（admin grant 不应连接它）。 */
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

/** 以子进程执行 `pnpm capybara <args>`。 */
function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const isAdmin = async (login: string) => {
  const row = await kernelDb(raw)
    .selectFrom("identities")
    .innerJoin("accounts", "accounts.id", "identities.account_id")
    .select("accounts.is_enterprise_admin")
    .where("identities.source", "=", "local")
    .where("identities.external_id", "=", login)
    .executeTakeFirstOrThrow();
  return row.is_enterprise_admin;
};

const cliAudits = () =>
  kernelDb(raw)
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("action", "=", "account.updated")
    .orderBy("id")
    .execute();

describe("capybara admin grant / revoke", () => {
  it("grant → 退出码 0，账号成为企业管理员并写审计（via cli）；再 revoke → 撤销", async () => {
    const g = await run(["admin", "grant", "alice"]);
    expect(g.code, g.stderr).toBe(0);
    expect(g.stdout).toContain("alice");
    expect(await isAdmin("alice")).toBe(true);

    const r = await run(["admin", "revoke", "Alice"]);
    expect(r.code, r.stderr).toBe(0);
    expect(await isAdmin("alice")).toBe(false);
    expect((await cliAudits()).map((e) => [e.actor_account_id, e.detail])).toEqual([
      [null, { isEnterpriseAdmin: true, via: "cli" }],
      [null, { isEnterpriseAdmin: false, via: "cli" }],
    ]);
  }, 60_000);

  it("撤销最后一个企业管理员 → 退出码 1，stderr 含 account.last_enterprise_admin，库不变", async () => {
    const r = await run(["admin", "revoke", "root"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("account.last_enterprise_admin");
    expect(await isAdmin("root")).toBe(true);
  }, 60_000);

  it("账号不存在 → 退出码 1", async () => {
    const r = await run(["admin", "grant", "ghost"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("account.not_found");
  }, 60_000);

  it("缺登录名 → 退出码 2", async () => {
    const r = await run(["admin", "grant"]);
    expect(r.code).toBe(2);
  }, 60_000);
});
