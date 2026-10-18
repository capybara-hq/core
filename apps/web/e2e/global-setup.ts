/**
 * e2e 全局准备：Testcontainers 起 PostgreSQL 与 Valkey，用 CLI（`capybara migrate` / `start`）
 * 从源码起一个加载 `model-fake` 与 `connector-mcp`（允许本机 http）的内核，再用 server.mjs 起 Web 层
 * （`next dev`）指向它；另起一个假 MCP 服务（带一个 destructive 工具 `delete_item`）供工具 / 审批用例接入。
 * Web 地址写入 `CAPYBARA_E2E_BASE_URL`（worker 进程继承，作为 Playwright 的 baseURL），
 * 假 MCP 端点写入 `CAPYBARA_E2E_MCP_URL`。
 * 返回的函数是全局清理：停 Web、停内核、停 MCP 服务、停容器、删临时目录。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webDir = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repoRoot, "apps/capybara/bin/capybara.mjs");
const modelFake = join(repoRoot, "plugins/model-fake/src/index.ts");
const connectorMcp = join(repoRoot, "plugins/connector-mcp/src/index.ts");
/**
 * 假 MCP 服务（测试工具包的源码）：按路径加载，与插件一样不作为 apps/web 的包依赖
 * （apps/web 只依赖 @capybara-hq/design）。
 */
const fakeMcpModule = join(repoRoot, "packages/testing/src/fake-mcp-server.ts");
/** 子进程日志（gitignore；每次运行覆盖，失败后可查看）。 */
const logDir = join(webDir, "e2e-logs");

type Cleanup = () => Promise<void>;

/** 用到的 `startFakeMcpServer` 子集（类型在这里声明，不 import 测试工具包）。 */
type StartFakeMcp = (opts: {
  tools: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    handler?: (info: { args: Record<string, unknown> }) => {
      content: { type: "text"; text: string }[];
    };
  }[];
}) => Promise<{ url: string; stop(): Promise<void> }>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 子进程的 stdout / stderr 写入日志文件（失败时打印尾部便于排查）。 */
function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  log: string,
  cwd = repoRoot,
): ChildProcess {
  const out = createWriteStream(log);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function stopChild(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const done = await Promise.race([
    exited(child).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
  if (!done) child.kill("SIGKILL");
}

async function waitFor(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`process exited (${child.exitCode}) before ${url}`);
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // 尚未监听
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function tail(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").slice(-40).join("\n");
}

export default async function globalSetup(): Promise<Cleanup> {
  const cleanups: Cleanup[] = [];
  const cleanup: Cleanup = async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch((e: unknown) => console.error("[e2e] cleanup failed", e));
    }
  };
  const dir = await mkdtemp(join(tmpdir(), "capybara-e2e-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(logDir, { recursive: true });
  const logs = {
    migrate: join(logDir, "migrate.log"),
    kernel: join(logDir, "kernel.log"),
    web: join(logDir, "web.log"),
  };
  try {
    const [pg, valkey] = await Promise.all([
      new PostgreSqlContainer("postgres:17").start(),
      new GenericContainer("valkey/valkey:8")
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
        .start(),
    ]);
    cleanups.push(async () => {
      await Promise.all([pg.stop(), valkey.stop()]);
    });

    const { startFakeMcpServer } = (await import(fakeMcpModule)) as {
      startFakeMcpServer: StartFakeMcp;
    };
    const mcp = await startFakeMcpServer({
      tools: [
        {
          name: "delete_item",
          description: "Delete an item by id. This cannot be undone.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "Item id" } },
            required: ["id"],
          },
          annotations: { destructiveHint: true },
          handler: ({ args }) => ({
            content: [{ type: "text", text: `deleted ${String(args.id)}` }],
          }),
        },
      ],
    });
    cleanups.push(() => mcp.stop());

    const [kernelPort, webPort] = [await freePort(), await freePort()];
    const configFile = join(dir, "capybara.yaml");
    const config = {
      db: { url: pg.getConnectionUri() },
      redis: { url: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}` },
      masterKey: randomBytes(32).toString("base64"),
      plugins: [modelFake, connectorMcp],
      pluginConfig: { "connector-mcp": { allowInsecureLoopback: true } },
      http: { port: kernelPort, trustProxy: 1 },
      auth: { cookieSecure: false },
      log: { level: "warn" },
    };
    // YAML 是 JSON 的超集
    await writeFile(configFile, JSON.stringify(config, null, 2));
    const kernelEnv = { CAPYBARA_CONFIG_SOURCE: "file", CAPYBARA_CONFIG_FILE: configFile };

    const migrate = run(process.execPath, [cli, "migrate"], kernelEnv, logs.migrate);
    if ((await exited(migrate)) !== 0) {
      throw new Error(`capybara migrate failed:\n${await tail(logs.migrate)}`);
    }

    const kernel = run(process.execPath, [cli, "start"], kernelEnv, logs.kernel);
    cleanups.push(() => stopChild(kernel));
    await waitFor(`http://127.0.0.1:${kernelPort}/readyz`, kernel, 60_000).catch(async (e) => {
      throw new Error(`${(e as Error).message}\n${await tail(logs.kernel)}`);
    });

    const web = run(
      process.execPath,
      [join(webDir, "server.mjs")],
      {
        PORT: String(webPort),
        CAPYBARA_KERNEL_URL: `http://127.0.0.1:${kernelPort}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      logs.web,
      // next-intl 插件按 cwd 解析 ./src/i18n/request.ts
      webDir,
    );
    cleanups.push(() => stopChild(web, 10_000));
    const baseUrl = `http://localhost:${webPort}`;
    // 首次请求触发 next dev 编译；顺带预热登录 / 初始化页
    await waitFor(`${baseUrl}/zh/login`, web, 180_000).catch(async (e) => {
      throw new Error(`${(e as Error).message}\n${await tail(logs.web)}`);
    });
    process.env.CAPYBARA_E2E_BASE_URL = baseUrl;
    process.env.CAPYBARA_E2E_MCP_URL = mcp.url;
    console.log(`[e2e] kernel :${kernelPort}, web ${baseUrl}, logs in ${logDir}`);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return cleanup;
}
