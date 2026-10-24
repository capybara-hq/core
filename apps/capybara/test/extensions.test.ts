import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  createKernel,
  createLogger,
  type Kernel,
  KernelConfigSchema,
  kernelDb,
} from "@capybara-hq/kernel";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 内核测试的插件包夹具（生命周期用的 life 插件）
import { lifePkg } from "../../../packages/kernel/test/helpers/plugin-packages.js";
import { parseInstallTarget } from "../src/commands/extensions.js";

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
const UI_A = kernelFixture("ui-a");
const UI_A_VIEW = kernelFixture("ui-a-view");
const UI_A_EMBED = kernelFixture("ui-a-embed");
const SANDBOX_FAKE = kernelFixture("sandbox-fake");
/** 内置插件（C14）出现在配置列表里时以内置为准。 */
const S3 = fileURLToPath(new URL("../../../plugins/object-store-s3/src/index.ts", import.meta.url));

let pg: TestContainer;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

/** 测试库的环境变量：剥掉父进程的 CAPYBARA_*，Redis 给不可达地址（extensions 命令不应连接它）。 */
function testEnv(
  plugins: string[] = [TODO, COUNTER],
  redisUrl = "redis://127.0.0.1:1",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: redisUrl,
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CAPYBARA_EXTENSIONS: JSON.stringify(plugins),
  };
}

/** 以子进程执行 `pnpm capybara <args>`，stdin 写入给定内容后关闭。 */
function run(
  args: string[],
  stdin = "",
  plugins?: string[],
  redisUrl?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(plugins, redisUrl),
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
      .selectFrom("extension_permission_snapshots")
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
      .where("action", "=", "extension.permissions_approved")
      .orderBy("at")
      .execute();
  } finally {
    await raw.destroy();
  }
}

// 各用例按顺序依赖前一步的库状态
describe("capybara extensions review / approve", () => {
  it("review：列出待批准插件与新增项（无快照全部为新增）", async () => {
    const r = await run(["extensions", "review"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("todo 0.1.0");
    expect(r.stdout).toContain("+ permissions.tools:write");
    expect(r.stdout).toContain("+ table:todos");
    expect(r.stdout).toContain("example-counter 0.1.0");
    expect(r.stdout).toContain("capybara extensions approve");
  }, 60_000);

  it("approve 交互确认回答 n → 退出码 1，不写快照", async () => {
    const r = await run(["extensions", "approve", "todo"], "n\n");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ permissions.tools:write");
    expect(r.stdout).toMatch(/\[y\/N\]/);
    expect(await snapshots()).toEqual([]);
  }, 60_000);

  it("approve 交互确认回答 y → 写快照（source cli）与审计（无 actor），提示重启", async () => {
    const r = await run(["extensions", "approve", "todo"], "y\n");
    expect(r.code, r.stderr).toBe(0);
    // Redis 不可达：只告警，运行中的副本等下一个周期 reconcile（不需要重启）
    expect(r.stdout).toMatch(/next periodic reconcile/i);
    expect(r.stdout).not.toMatch(/restart/i);
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
    const r = await run(["extensions", "approve", "example-counter", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect((await snapshots()).map((s) => s.plugin)).toEqual(["example-counter", "todo"]);
    const review = await run(["extensions", "review"]);
    expect(review.code).toBe(0);
    expect(review.stdout).toMatch(/no extensions await/i);
  }, 60_000);

  it("已批准且无新增 → 提示无需批准，退出码 0；未配置的插件 → 退出码 1", async () => {
    const again = await run(["extensions", "approve", "todo", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/no new permissions/i);
    expect(await approvalsAudit()).toHaveLength(2);
    const unknown = await run(["extensions", "approve", "nope", "--yes"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nope");
  }, 60_000);

  it("自身已批准、只被待批准的依赖阻塞 → 点名阻塞的提供方，退出码 1", async () => {
    const plugins = [PERM_A, PERM_DEP];
    const first = await run(["extensions", "approve", "perm-dep", "--yes"], "", plugins);
    expect(first.code, first.stderr).toBe(0);
    const review = await run(["extensions", "review"], "", plugins);
    expect(review.stdout).toContain("perm-dep 0.1.0: not loaded: requires counter@1");
    const again = await run(["extensions", "approve", "perm-dep", "--yes"], "", plugins);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("counter@1 (provided only by perm-a)");
    expect(again.stdout).not.toMatch(/no new permissions/i);
  }, 60_000);

  it("敏感项标 (sensitive)：review 与 approve 列表；只多出 view 不需要批准", async () => {
    // 新插件（无快照）：全部为新增，工具 / embed 标敏感，view 与普通路由不标
    const review = await run(["extensions", "review"], "", [UI_A_EMBED]);
    expect(review.code, review.stderr).toBe(0);
    const lines = review.stdout.split("\n");
    expect(lines).toContain("  + ui.embed:board  (sensitive)");
    expect(lines).toContain("  + ui.view:tasks");
    expect(lines).toContain("  + permissions.http:GET /ui/board");
    const listing = await run(["extensions", "approve", "ui-a"], "n\n", [UI_A_EMBED]);
    expect(listing.code).toBe(1);
    expect(listing.stdout.split("\n")).toContain("  + ui.embed:board  (sensitive)");
    expect(listing.stdout.split("\n")).toContain("  + ui.view:tasks");

    // 批准 0.1.0 后升级到只多出 view 的 0.2.0：无需批准
    const base = await run(["extensions", "approve", "ui-a", "--yes"], "", [UI_A]);
    expect(base.code, base.stderr).toBe(0);
    const viewOnly = await run(["extensions", "review"], "", [UI_A_VIEW]);
    expect(viewOnly.stdout).toMatch(/no extensions await/i);
    const approveView = await run(["extensions", "approve", "ui-a", "--yes"], "", [UI_A_VIEW]);
    expect(approveView.code).toBe(0);
    expect(approveView.stdout).toMatch(/no new permissions/i);
  }, 120_000);

  it("提供 sandbox@1 / object-store@1 标 (sensitive)；内置插件预先批准，不进 review，approve 无需批准", async () => {
    const plugins = [SANDBOX_FAKE, S3];
    const review = await run(["extensions", "review"], "", plugins);
    expect(review.code, review.stderr).toBe(0);
    const lines = review.stdout.split("\n");
    expect(lines).toContain("  + provides:sandbox@1  (sensitive)");
    expect(review.stdout).toContain("sandbox-fake 0.1.0");
    expect(review.stdout).not.toContain("object-store-s3");
    const approveBuiltin = await run(
      ["extensions", "approve", "object-store-s3", "--yes"],
      "",
      plugins,
    );
    expect(approveBuiltin.code, approveBuiltin.stderr).toBe(0);
    expect(approveBuiltin.stdout).toMatch(/built in.*pre-approved/i);
    expect((await snapshots()).map((s) => s.plugin)).not.toContain("object-store-s3");
  }, 120_000);
});

describe("parseInstallTarget", () => {
  it("npm:<名>[@<版本>]（含 scope）与本地文件", () => {
    expect(parseInstallTarget("npm:@acme/x@1.2.3")).toEqual({
      kind: "npm",
      package: "@acme/x",
      version: "1.2.3",
    });
    expect(parseInstallTarget("npm:@acme/x")).toEqual({ kind: "npm", package: "@acme/x" });
    expect(parseInstallTarget("npm:plain@latest")).toEqual({
      kind: "npm",
      package: "plain",
      version: "latest",
    });
    expect(parseInstallTarget("./a.tgz")).toEqual({ kind: "file", path: "./a.tgz" });
  });
});

/** Install records (C18, F-Q): the CLI writes PG (the package goes to extension_blobs) and publishes over Redis; a running kernel loads it without a restart. */
describe("capybara extensions install / enable / disable / uninstall（运行中的内核经 bus 收敛）", () => {
  let rd: TestContainer;
  let k: Kernel;
  let work: string;
  let tgzPath: string;
  const waitFor = async (fn: () => boolean | Promise<boolean>, label: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const cli = (args: string[], stdin = "") => run(args, stdin, [], rd.url);

  beforeAll(async () => {
    rd = await startTestRedis();
    work = await mkdtemp(join(tmpdir(), "cli-plugins-"));
    tgzPath = join(work, "life-1.0.0.tgz");
    await writeFile(tgzPath, await lifePkg({ version: "1.0.0" }));
    const config = KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 3 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      roles: ["api", "worker"],
      extensions: [],
      extensionPermissions: { autoApprove: false },
      extensionHost: { dir: join(work, "plugins"), reconcileIntervalSeconds: 3600 },
      log: { level: "error" },
    });
    k = await createKernel(config, { env: {}, logger: createLogger("error", { write: () => {} }) });
    await k.start();
  }, 120_000);
  afterAll(async () => {
    await k?.stop();
    await rd?.stop();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("install（新装停用）→ review 列出 → approve → enable：内核收到消息后加载；disable / uninstall 同样收敛", async () => {
    // 先展示审阅（权限增减）再确认；回答 n → 不安装（只存了包）
    const declined = await cli(["extensions", "install", tgzPath], "n\n");
    expect(declined.code).toBe(1);
    expect(declined.stdout).toContain("+ permissions.tools:wait");
    expect(declined.stdout).toMatch(/Install life 1\.0\.0\? \[y\/N\]/);
    expect(declined.stdout).toContain("Not installed");
    const none = createDb(pg.url, 1);
    try {
      expect(
        await kernelDb(none).selectFrom("extension_installs").select("name").execute(),
      ).toEqual([]);
    } finally {
      await none.destroy();
    }
    const inst = await cli(["extensions", "install", tgzPath], "y\n");
    expect(inst.code, inst.stderr).toBe(0);
    expect(inst.stdout).toContain("+ permissions.tools:wait");
    expect(inst.stdout).toContain("Installed life 1.0.0");
    // --yes 跳过确认（脚本用）：同一个包再装一次不改什么
    const again = await cli(["extensions", "install", tgzPath, "--yes"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("[y/N]");
    expect(inst.stdout).toContain("capybara extensions approve life");
    expect(inst.stdout).toContain("capybara extensions enable life");
    const raw = createDb(pg.url, 1);
    try {
      const pkg = await kernelDb(raw)
        .selectFrom("extension_packages")
        .select(["blob_store", "source"])
        .where("name", "=", "life")
        .executeTakeFirstOrThrow();
      expect(pkg).toEqual({ blob_store: "pg", source: "file" });
      const audit = await kernelDb(raw)
        .selectFrom("audit_events")
        .select(["actor_account_id", "detail"])
        .where("action", "=", "extension.installed")
        .where("target", "=", "life")
        .executeTakeFirstOrThrow();
      expect(audit.actor_account_id).toBeNull();
      expect(audit.detail).toMatchObject({ name: "life", version: "1.0.0" });
    } finally {
      await raw.destroy();
    }

    const review = await cli(["extensions", "review"]);
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain("life 1.0.0: awaiting approval (new extension");
    expect(review.stdout).toContain("+ permissions.tools:wait");

    const enable = await cli(["extensions", "enable", "life"]);
    expect(enable.code, enable.stderr).toBe(0);
    expect(enable.stdout).toContain("capybara extensions approve life");
    const approve = await cli(["extensions", "approve", "life", "--yes"]);
    expect(approve.code, approve.stderr).toBe(0);
    expect(approve.stdout).toMatch(/Running replicas load it without a restart/);
    await waitFor(() => k.host.current("life")?.version === "1.0.0", "kernel loaded life");

    const list = await cli(["extensions", "list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout.split("\n")).toContainEqual(
      expect.stringMatching(/^life\t1\.0\.0\tinstall\tenabled\t(enabled|converging)$/),
    );

    const early = await cli(["extensions", "uninstall", "life"]);
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(/disable it before uninstalling/);

    const disable = await cli(["extensions", "disable", "life"]);
    expect(disable.code, disable.stderr).toBe(0);
    await waitFor(() => k.host.current("life") === undefined, "kernel unloaded life");
    const uninstall = await cli(["extensions", "uninstall", "life"]);
    expect(uninstall.code, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).toMatch(/data .* is kept/);
    const after = await cli(["extensions", "list"]);
    expect(after.stdout).not.toMatch(/^life\t/m);
  }, 180_000);

  it("包存在 CLI 读不到的对象存储里（网页安装）：disable 已生效 → 退出码 0，附说明", async () => {
    const raw = createDb(pg.url, 1);
    const sha = "e".repeat(64);
    try {
      const db = kernelDb(raw);
      await db
        .insertInto("extension_packages")
        .values({
          sha256: sha,
          name: "webpkg",
          package_name: "@test/plugin-webpkg",
          version: "1.0.0",
          size: 1,
          section: JSON.stringify({ kind: "plugin" }),
          blob_store: "object",
          source: "file",
          source_ref: "upload",
        })
        .execute();
      await db
        .insertInto("extension_installs")
        .values({
          name: "webpkg",
          sha256: sha,
          version: "1.0.0",
          source: "file",
          desired_state: "enabled",
        })
        .execute();
      const r = await cli(["extensions", "disable", "webpkg"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("Disabled webpkg 1.0.0");
      expect(r.stdout).toMatch(/status unknown: the package is kept in object storage/);
      const row = await db
        .selectFrom("extension_installs")
        .select("desired_state")
        .where("name", "=", "webpkg")
        .executeTakeFirstOrThrow();
      expect(row.desired_state).toBe("disabled");
      await db.deleteFrom("extension_installs").where("name", "=", "webpkg").execute();
    } finally {
      await raw.destroy();
    }
  }, 60_000);
});

describe("capybara extensions review：部署配置问题（C10）", () => {
  const BADCONFIG = kernelFixture("badconfig");

  it("缺必填字段时列出路径与说明（不含值）；PG 里补上后不再列出", async () => {
    const r = await run(["extensions", "review"], "", [BADCONFIG]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("badconfig 0.1.0: not loaded until its deployment config is fixed:");
    expect(r.stdout).toContain("  ! port: expected number");
    expect(r.stdout).toMatch(/admin console/);

    const raw = createDb(pg.url, 1);
    try {
      await kernelDb(raw)
        .insertInto("extension_deployment_configs")
        .values({ plugin: "badconfig", config: JSON.stringify({ port: 8080 }) })
        .execute();
    } finally {
      await raw.destroy();
    }
    const after = await run(["extensions", "review"], "", [BADCONFIG]);
    expect(after.code, after.stderr).toBe(0);
    expect(after.stdout).not.toContain("badconfig 0.1.0: not loaded");
  }, 60_000);
});
