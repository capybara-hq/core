/**
 * e2e 全局准备：Testcontainers 起 PostgreSQL 与 Valkey，用 CLI（`capybara migrate` / `start`）
 * 从源码起一个加载 `model-fake`、`connector-mcp`、`connector-openapi`（都允许本机 http）、`todo` 与假 IM 测试插件 `fake-im` 的内核，再用 server.mjs 起 Web 层
 * （`next dev`）指向它；另起一个假 MCP 服务（有状态会话；destructive 工具 `delete_item`、会发起 elicitation 的 `signup`、
 * 提示模板 `summarize` 与资源 `docs://handbook`）供工具 / 审批 / 斜杠命令 / 资源引用用例接入；再起一个假 OpenAPI 服务
 * （宠物 CRUD，要求请求头 API key）供安装向导用例接入。
 * Web 地址写入 `CAPYBARA_E2E_BASE_URL`（worker 进程继承，作为 Playwright 的 baseURL），
 * 假 MCP 端点写入 `CAPYBARA_E2E_MCP_URL`，假 OpenAPI 文档地址与 API key 写入 `CAPYBARA_E2E_OPENAPI_SPEC_URL` /
 * `CAPYBARA_E2E_OPENAPI_KEY`。
 * 返回的函数是全局清理：停 Web、停内核、停假服务、停容器、删临时目录。
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
const connectorOpenApi = join(repoRoot, "plugins/connector-openapi/src/index.ts");
/** todo 插件：工具 todo__write 与对话视图 tasks（右侧「任务」标签）。 */
const todo = join(repoRoot, "plugins/todo/src/index.ts");
/**
 * 假 IM 测试插件（内核测试夹具：channel@1 + identity-source@1 + directory@1），按路径加载。
 * 渠道连接的平台地址写在连接配置里（im-channels.spec 在 worker 里自起假 IM 平台）；部署级的 platformUrl
 * 只用于第三方登录，e2e 不走那条路，给一个占位地址。
 */
const fakeIm = join(repoRoot, "packages/kernel/test/fixtures/plugins/fake-im/index.ts");
/**
 * 假 MCP 服务（测试工具包的源码）：按路径加载，与插件一样不作为 apps/web 的包依赖
 * （apps/web 只依赖 @capybara-hq/design）。
 */
const fakeMcpModule = join(repoRoot, "packages/testing/src/fake-mcp-server.ts");
const fakeOpenApiModule = join(repoRoot, "packages/testing/src/fake-openapi-server.ts");
/** 假 OpenAPI 服务要求的 API key（e2e 用例在安装向导里填写）。 */
const OPENAPI_KEY = "e2e-openapi-key-7f3a";

/** 用到的 `startFakeOpenApiServer` 子集。 */
type StartFakeOpenApi = (opts: {
  apiKey?: string;
}) => Promise<{ specUrl: string; stop(): Promise<void> }>;
/** 子进程日志（gitignore；每次运行覆盖，失败后可查看）。 */
const logDir = join(webDir, "e2e-logs");

type Cleanup = () => Promise<void>;

/** 用到的 `startFakeMcpServer` 子集（类型在这里声明，不 import 测试工具包）。 */
type StartFakeMcp = (opts: {
  sessions?: boolean;
  tools: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    handler?: (
      info: { args: Record<string, unknown> },
      ctx: {
        elicit(params: {
          message: string;
          requestedSchema: Record<string, unknown>;
        }): Promise<{ action: string; content?: Record<string, unknown> }>;
      },
    ) =>
      | { content: { type: "text"; text: string }[] }
      | Promise<{ content: { type: "text"; text: string }[] }>;
  }[];
  prompts?: {
    name: string;
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
    render?: (
      args: Record<string, string>,
    ) => { role: "user"; content: { type: "text"; text: string } }[];
  }[];
  resources?: { uri: string; name: string; mimeType?: string; text?: string }[];
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
      // 有状态会话：elicitation 的答复要送回发起它的调用
      sessions: true,
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
        {
          name: "signup",
          description: "Sign the user up; asks for their name.",
          annotations: { readOnlyHint: true },
          handler: async (_info, ctx) => {
            const r = await ctx.elicit({
              message: "Sign up",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string", title: "Name" } },
                required: ["name"],
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    r.action === "accept"
                      ? `welcome ${String(r.content?.name)}`
                      : `signup ${r.action}`,
                },
              ],
            };
          },
        },
      ],
      prompts: [
        {
          name: "summarize",
          description: "Summarize a topic",
          arguments: [{ name: "topic", description: "What to summarize", required: true }],
          render: (args) => [
            { role: "user", content: { type: "text", text: `Summarize ${args.topic}` } },
          ],
        },
      ],
      resources: [
        { uri: "docs://handbook", name: "Handbook", mimeType: "text/markdown", text: "# Handbook" },
      ],
    });
    cleanups.push(() => mcp.stop());

    const { startFakeOpenApiServer } = (await import(fakeOpenApiModule)) as {
      startFakeOpenApiServer: StartFakeOpenApi;
    };
    const openapi = await startFakeOpenApiServer({ apiKey: OPENAPI_KEY });
    cleanups.push(() => openapi.stop());

    const [kernelPort, webPort] = [await freePort(), await freePort()];
    const configFile = join(dir, "capybara.yaml");
    const config = {
      db: { url: pg.getConnectionUri() },
      redis: { url: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}` },
      masterKey: randomBytes(32).toString("base64"),
      plugins: [modelFake, connectorMcp, connectorOpenApi, fakeIm, todo],
      pluginConfig: {
        "connector-mcp": { allowInsecureLoopback: true },
        "connector-openapi": { allowInsecureLoopback: true },
        "fake-im": {
          platformUrl: "http://127.0.0.1:9",
          clientId: "e2e-login",
          clientSecret: "e2e-login-secret",
        },
      },
      // e2e 自动批准插件权限（生产默认关闭）
      pluginPermissions: { autoApprove: true },
      // publicUrl：机器人发的绑定链接指向 Web 层（`<publicUrl>/bind/<token>`）
      http: { port: kernelPort, trustProxy: 1, publicUrl: `http://localhost:${webPort}` },
      auth: { cookieSecure: false, loginSources: ["fake-im"] },
      // 渠道长连接的扫描加快，建连接后很快连上
      channels: { leaseTtlMs: 3000, scanIntervalMs: 500 },
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
    process.env.CAPYBARA_E2E_OPENAPI_SPEC_URL = openapi.specUrl;
    process.env.CAPYBARA_E2E_OPENAPI_KEY = OPENAPI_KEY;
    console.log(`[e2e] kernel :${kernelPort}, web ${baseUrl}, logs in ${logDir}`);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return cleanup;
}
