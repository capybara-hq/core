import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb, kernelDb } from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TODO = fileURLToPath(new URL("../../../plugins/todo/src/index.ts", import.meta.url));
const COUNTER = fileURLToPath(
  new URL("../../../plugins/example-counter/src/index.ts", import.meta.url),
);
/** 内核测试夹具：perm-dep 必需依赖只由 perm-a 提供的 counter@1。 */
const kernelFixture = (n: string) =>
  fileURLToPath(
    new URL(`../../../packages/kernel/test/fixtures/plugins/${n}/index.ts`, import.meta.url),
  );
const PERM_A = kernelFixture("perm-a");
const PERM_DEP = kernelFixture("perm-dep");

let pg: TestContainer;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

/** 测试库的环境变量：剥掉父进程的 CAPYBARA_*，Redis 给不可达地址（plugins 命令不应连接它）。 */
function testEnv(plugins: string[] = [TODO, COUNTER]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CAPYBARA_PLUGINS: JSON.stringify(plugins),
  };
}

/** 以子进程执行 `pnpm capybara <args>`，stdin 写入给定内容后关闭。 */
function run(
  args: string[],
  stdin = "",
  plugins?: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(plugins),
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(stdin);
  });
}

async function snapshots() {
  const raw = createDb(pg.url, 1);
  try {
    return await kernelDb(raw)
      .selectFrom("plugin_permission_snapshots")
      .select(["plugin", "version", "source", "approved_by"])
      .orderBy("plugin")
      .execute();
  } finally {
    await raw.destroy();
  }
}

async function approvalsAudit() {
  const raw = createDb(pg.url, 1);
  try {
    return await kernelDb(raw)
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "detail"])
      .where("action", "=", "plugin.permissions_approved")
      .orderBy("at")
      .execute();
  } finally {
    await raw.destroy();
  }
}

// 各用例按顺序依赖前一步的库状态
describe("capybara plugins review / approve", () => {
  it("review：列出待批准插件与新增项（无快照全部为新增）", async () => {
    const r = await run(["plugins", "review"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("todo 0.1.0");
    expect(r.stdout).toContain("+ permissions.tools:write");
    expect(r.stdout).toContain("+ table:todos");
    expect(r.stdout).toContain("example-counter 0.1.0");
    expect(r.stdout).toContain("capybara plugins approve");
  }, 60_000);

  it("approve 交互确认回答 n → 退出码 1，不写快照", async () => {
    const r = await run(["plugins", "approve", "todo"], "n\n");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ permissions.tools:write");
    expect(r.stdout).toMatch(/\[y\/N\]/);
    expect(await snapshots()).toEqual([]);
  }, 60_000);

  it("approve 交互确认回答 y → 写快照（source cli）与审计（无 actor），提示重启", async () => {
    const r = await run(["plugins", "approve", "todo"], "y\n");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/restart the kernel/i);
    expect(await snapshots()).toEqual([
      { plugin: "todo", version: "0.1.0", source: "cli", approved_by: null },
    ]);
    const audits = await approvalsAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_account_id: null, target: "todo" });
    expect(audits[0]?.detail).toMatchObject({
      plugin: "todo",
      version: "0.1.0",
      source: "cli",
      added: expect.arrayContaining(["permissions.tools:write"]),
      removed: [],
    });
  }, 60_000);

  it("approve --yes 跳过确认；之后 review 无待批准", async () => {
    const r = await run(["plugins", "approve", "example-counter", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect((await snapshots()).map((s) => s.plugin)).toEqual(["example-counter", "todo"]);
    const review = await run(["plugins", "review"]);
    expect(review.code).toBe(0);
    expect(review.stdout).toMatch(/no plugins await/i);
  }, 60_000);

  it("已批准且无新增 → 提示无需批准，退出码 0；未配置的插件 → 退出码 1", async () => {
    const again = await run(["plugins", "approve", "todo", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/no new permissions/i);
    expect(await approvalsAudit()).toHaveLength(2);
    const unknown = await run(["plugins", "approve", "nope", "--yes"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nope");
  }, 60_000);

  it("自身已批准、只被待批准的依赖阻塞 → 点名阻塞的提供方，退出码 1", async () => {
    const plugins = [PERM_A, PERM_DEP];
    const first = await run(["plugins", "approve", "perm-dep", "--yes"], "", plugins);
    expect(first.code, first.stderr).toBe(0);
    const review = await run(["plugins", "review"], "", plugins);
    expect(review.stdout).toContain("perm-dep 0.1.0: not loaded: requires counter@1");
    const again = await run(["plugins", "approve", "perm-dep", "--yes"], "", plugins);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("counter@1 (provided only by perm-a)");
    expect(again.stdout).not.toMatch(/no new permissions/i);
  }, 60_000);
});
