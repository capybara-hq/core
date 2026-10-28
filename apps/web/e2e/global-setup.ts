/**
 * e2e global setup: Testcontainers start PostgreSQL and Valkey, and the CLI (`capybara migrate` /
 * `start`) starts a kernel from source that loads `model-fake`, the core fakes of
 * `@capybara-hq/testing` (`fake-connector` as connector kind `mcp`, so the web install wizard
 * drives it as an MCP connector; `fake-openapi`, connector kind `openapi`, for the wizard's OpenAPI
 * flow; `fake-tools-ui`, a tool with a conversation view; `fake-embed`, an org page and a
 * conversation tab embed), all allowing local http, and the fake IM test plugin `fake-im`; no
 * official plugin except `model-fake` and the bootstrap plugins; server.mjs then
 * starts the web layer (`next dev`) pointing at it. A fake MCP server
 * (stateful sessions; the destructive tool `delete_item`, `signup` which starts an elicitation, the
 * prompt `summarize` and the resource `docs://handbook`) serves the tool / approval / slash command /
 * resource reference cases; a small pets API (an operations document for `fake-openapi` and the
 * operations behind an API key request header) serves the OpenAPI install wizard case. A SeaweedFS (S3-compatible) container is the object store through the
 * `object-store-s3` plugin, for the attachment upload cases (the browser posts the presigned form
 * cross-origin). object-store-s3 and openai-compatible are the bootstrap plugins: downloaded at the
 * versions packages/kernel/bootstrap.json pins from the npm registry and checked against their
 * sha512, as the image build does (`pnpm pack-bootstrap --registry`; the only network access of
 * this setup, `CAPYBARA_PACKAGES__NPM_REGISTRY` names a mirror), into a temp dir that
 * `capybara start --bootstrap-dir` installs from before loading extensions (as a deployment without
 * the init container). `model-fake`'s
 * fake-1 declares image and document support. The sandbox is the kernel test fixture `sandbox-fake`
 * (a real /bin/sh, instance directories under a temp dir, for tests only), for the artifact case
 * (sandbox_write -> sandbox_deliver -> the artifacts tab).
 * The web URL goes into `CAPYBARA_E2E_BASE_URL` (inherited by the worker processes as Playwright's
 * baseURL), the fake MCP endpoint into `CAPYBARA_E2E_MCP_URL`, the pets API's document URL and
 * API key into `CAPYBARA_E2E_OPENAPI_SPEC_URL` / `CAPYBARA_E2E_OPENAPI_KEY`. An extension package
 * `greeter` (the kernel test kit's `greeterPkg`: a tool plus deployment config) is written to
 * `CAPYBARA_E2E_GREETER_TGZ` for the admin extension page case, which uploads it in the browser. A
 * fake git server holds a git marketplace repository (two versions of the skills plugin `notes`);
 * its URL goes into `CAPYBARA_E2E_GIT_MARKETPLACE_URL` for the catalog case that adds it and
 * upgrades the plugin.
 * The returned function is the global cleanup: stop web, the kernel, the fakes and the containers,
 * and remove the temp dir.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { register } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";

// 按路径加载的内核测试工具（plugin-packages.ts 等）会 import workspace 包（@capybara-hq/plugin-sdk）：与 CLI 入口
// （apps/capybara/bin/capybara.mjs）一样补上 `@capybara-hq/source` 导出条件，解析到 src 而不是 dist
// （CI 的 e2e 只 pnpm install、不 build，没有 dist）。只影响之后的 import，所以放在任何动态 import 之前
register(
  "data:text/javascript,export function resolve(s, c, next) { return next(s, { ...c, conditions: [...c.conditions, '@capybara-hq/source'] }); }",
);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webDir = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repoRoot, "apps/capybara/bin/capybara.mjs");
const modelFake = join(repoRoot, "plugins/model-fake/src/index.ts");
/** Where the bootstrap plugins are downloaded from (the image build's default). */
const BOOTSTRAP_REGISTRY =
  process.env.CAPYBARA_PACKAGES__NPM_REGISTRY || "https://registry.npmjs.org/";
/** The core fakes (`@capybara-hq/testing` fixtures), loaded by path like the plugins. */
const fakeExtension = (name: string) =>
  join(repoRoot, "packages/testing/fixtures/extensions", name, "src/index.ts");
/** Connector extension `fake-connector`, configured as kind `mcp` (an MCP client). */
const fakeConnector = fakeExtension("fake-connector");
/** Tool `fake-tools-ui__write` and the conversation view `tasks` (the right-hand "条目" tab). */
const fakeToolsUi = fakeExtension("fake-tools-ui");
/** Embeds `panel` (org page) and `panel-conv` (conversation tab), token-checked routes. */
const fakeEmbed = fakeExtension("fake-embed");
/** Connector extension `fake-openapi` (kind `openapi`), for the wizard's OpenAPI flow. */
const fakeOpenApi = fakeExtension("fake-openapi");
/**
 * 假 IM 测试插件（内核测试夹具：channel@1 + identity-source@1 + directory@1），按路径加载。
 * 渠道连接的平台地址写在连接配置里（im-channels.spec 在 worker 里自起假 IM 平台）；部署级的 platformUrl
 * 只用于第三方登录，e2e 不走那条路，给一个占位地址。
 */
const fakeIm = join(repoRoot, "packages/testing/fixtures/extensions/fake-im/src/index.ts");
/**
 * 假 MCP 服务（测试工具包的源码）：按路径加载，与插件一样不作为 apps/web 的包依赖
 * （apps/web 只依赖 @capybara-hq/design）。
 */
const fakeMcpModule = join(repoRoot, "packages/testing/src/fake-mcp-server.ts");
const containersModule = join(repoRoot, "packages/testing/src/containers.ts");
/** 内核测试工具包里的插件包构造（按路径加载，不作为 apps/web 的依赖）。 */
const pluginPackagesModule = join(repoRoot, "packages/kernel/test/helpers/plugin-packages.ts");
/** Plugin builders of the kernel catalog tests (skills, connector templates, dependencies). */
const catalogPackagesModule = join(repoRoot, "packages/kernel/test/catalog/packages.ts");
const fakeMarketplaceModule = join(repoRoot, "packages/testing/src/fake-marketplace.ts");
const fakeNpmModule = join(repoRoot, "packages/testing/src/fake-npm-registry.ts");
const fakeGitModule = join(repoRoot, "packages/testing/src/fake-git-server.ts");
/** 假沙箱插件（内核测试夹具，sandbox@1；没有任何隔离，只用于测试）。 */
const sandboxFake = join(repoRoot, "packages/kernel/test/fixtures/plugins/sandbox-fake/index.ts");
/**
 * Kernel test fixture `hooks-probe` (policy hooks on model.request / tool.preExecute, configured
 * per org through its own route), for the hook-denial case of conversation-capabilities.spec.ts;
 * it does nothing until an org enables it.
 */
const hooksProbe = join(repoRoot, "packages/kernel/test/fixtures/plugins/hooks-probe/index.ts");
/** The API key the pets API asks for (the e2e case enters it in the install wizard). */
const OPENAPI_KEY = "e2e-openapi-key-7f3a";

/**
 * The pets API behind `fake-openapi`: `GET /doc.json` is its operations document (security scheme
 * `X-API-Key`, operations listPets / createPet / deletePet); the operations ask for the key.
 */
async function startPetsApi(apiKey: string): Promise<{ specUrl: string; stop(): Promise<void> }> {
  const doc = {
    securitySchemes: { apiKey: { type: "api_key", in: "header", name: "X-API-Key" } },
    operations: [
      {
        name: "listPets",
        method: "GET",
        path: "/pets",
        summary: "List pets",
        annotations: { readOnlyHint: true },
      },
      {
        name: "createPet",
        method: "POST",
        path: "/pets",
        summary: "Create a pet",
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: "deletePet",
        method: "DELETE",
        path: "/pets/1",
        summary: "Delete a pet",
        annotations: { destructiveHint: true },
      },
    ],
  };
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/doc.json") return json(res, 200, doc);
    if (req.headers["x-api-key"] !== apiKey) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/pets") return json(res, 200, []);
    if (req.method === "POST" && req.url === "/pets") {
      return json(res, 201, { id: 1, ...JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    }
    return json(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    specUrl: `http://127.0.0.1:${port}/doc.json`,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** 用到的 `startTestS3` 子集。 */
type StartTestS3 = () => Promise<{
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  stop(): Promise<void>;
}>;

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
        elicit(
          params:
            | { message: string; requestedSchema: Record<string, unknown> }
            | { mode: "url"; message: string; url: string; elicitationId: string },
        ): Promise<{ action: string; content?: Record<string, unknown> }>;
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

/** The subset of `startFakeNpmRegistry` / `startFakeMarketplace` used here. */
type StartFakeNpm = (opts: {
  packages: { name: string; version: string; tgz: Uint8Array }[];
}) => Promise<{ url: string; stop(): Promise<void> }>;
type StartFakeMarketplace = (opts: {
  manifest: unknown;
}) => Promise<{ url: string; stop(): Promise<void> }>;

/**
 * Fixtures of the catalog cases: the plugin `crm-core` (`@test/plugin-crm-core`, an extension only)
 * and the plugin `crm` (`@acme/plugin-crm`: the connector template `docs` (fake-connector, endpoint
 * at the fake MCP, url editable, no auth), the skill `crm-notes`, an icon, and a dependency on
 * `crm-core ^1.0.0`) go into a fake npm registry; the fake marketplace's `marketplace.json` lists
 * both by their packages' sha512, plus a git entry `crm-next` on github.com (listed, not importable:
 * `marketplaces.allowedHosts` only has 127.0.0.1). The catalog cases refresh the official
 * marketplace in the admin console and import both plugins from it.
 */
async function startCatalogFixtures(mcpUrl: string): Promise<{
  registryUrl: string;
  marketplaceUrl: string;
  stop(): Promise<void>;
}> {
  const { pluginTgz } = (await import(pluginPackagesModule)) as {
    pluginTgz: (o: {
      manifest: Record<string, unknown> & { name: string };
      packageName?: string;
      extension?: Record<string, unknown>;
    }) => Promise<Uint8Array>;
  };
  const { bundlePlugin, SVG_ICON } = (await import(catalogPackagesModule)) as {
    bundlePlugin: (o: {
      name: string;
      packageName?: string;
      manifest?: Record<string, unknown>;
      files?: Record<string, string>;
      dependencies?: { name: string; version: string }[];
      skills?: string[];
      templates?: Record<string, unknown>;
    }) => Promise<Uint8Array>;
    SVG_ICON: string;
  };
  const { startFakeNpmRegistry } = (await import(fakeNpmModule)) as {
    startFakeNpmRegistry: StartFakeNpm;
  };
  const { startFakeMarketplace } = (await import(fakeMarketplaceModule)) as {
    startFakeMarketplace: StartFakeMarketplace;
  };
  const { createHash } = await import("node:crypto");
  const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
  const core = await pluginTgz({
    manifest: {
      name: "crm-core",
      version: "1.0.0",
      publisher: "Acme",
      description: "CRM core extension for e2e",
    },
    packageName: "@test/plugin-crm-core",
    extension: {},
  });
  const crm = await bundlePlugin({
    name: "crm",
    packageName: "@acme/plugin-crm",
    manifest: {
      version: "1.0.0",
      description: "CRM plugin for e2e",
      displayName: { zh: "CRM 套件", en: "CRM Suite" },
      icon: "./icon.svg",
    },
    files: { "icon.svg": SVG_ICON },
    dependencies: [{ name: "crm-core", version: "^1.0.0" }],
    skills: ["crm-notes"],
    templates: {
      docs: {
        plugin: "fake-connector",
        connector: "mcp",
        endpoint: { url: mcpUrl },
        editableEndpoint: ["url"],
        auth: { type: "none" },
      },
    },
  });
  const registry = await startFakeNpmRegistry({
    packages: [
      { name: "@test/plugin-crm-core", version: "1.0.0", tgz: core },
      { name: "@acme/plugin-crm", version: "1.0.0", tgz: crm },
    ],
  });
  const npm = (pkg: string, tgz: Uint8Array) => ({
    npm: { package: pkg, version: "1.0.0", integrity: sri(tgz) },
  });
  const marketplace = await startFakeMarketplace({
    manifest: {
      schemaVersion: 1,
      name: "Official (e2e)",
      plugins: [
        {
          name: "crm-core",
          summary: { en: "CRM core", zh: "CRM 核心" },
          source: npm("@test/plugin-crm-core", core),
        },
        {
          name: "crm",
          summary: { en: "CRM suite", zh: "CRM 套件" },
          minKernel: "0.0.1",
          source: npm("@acme/plugin-crm", crm),
        },
        {
          name: "crm-next",
          summary: { en: "CRM from git" },
          version: "0.1.0",
          source: { git: { url: "https://github.com/acme/crm-next.git" } },
        },
      ],
    },
  });
  return {
    registryUrl: registry.url,
    marketplaceUrl: marketplace.url,
    async stop() {
      await Promise.all([registry.stop(), marketplace.stop()]);
    },
  };
}

/** The subset of `startFakeGitServer` used here. */
type StartFakeGit = () => Promise<{
  url(repo: string): string;
  commit(repo: string, files: Record<string, string>): Promise<string>;
  stop(): Promise<void>;
}>;

/** One version of the skills plugin `notes` (1.1.0 changes `notes` and adds `notes-extra`). */
function notesPlugin(version: string): Record<string, string> {
  const skill = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: ${name} skill for e2e\n---\n# ${name}\n\n${body}\n`;
  return {
    ".capybara-plugin/plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: "notes",
      version,
      publisher: "Acme",
      description: "Notes skills for e2e",
    }),
    "skills/notes/SKILL.md": skill("notes", `Take notes (${version}).`),
    ...(version !== "1.0.0" && {
      "skills/notes-extra/SKILL.md": skill("notes-extra", "More notes."),
    }),
  };
}

/**
 * A fake git server with two repositories: `notes` (two commits, `notes` 1.0.0 then 1.1.0) and the
 * git marketplace `marketplace`, whose `.capybara-plugin/marketplace.json` lists both versions as
 * git entries pinned to those commits (one source, so 1.1.0 adds a version to the same item).
 */
async function startGitMarketplace(): Promise<{ url: string; stop(): Promise<void> }> {
  const { startFakeGitServer } = (await import(fakeGitModule)) as {
    startFakeGitServer: StartFakeGit;
  };
  const git = await startFakeGitServer();
  const commits: Record<string, string> = {};
  for (const version of ["1.0.0", "1.1.0"]) {
    commits[version] = await git.commit("notes", notesPlugin(version));
  }
  await git.commit("marketplace", {
    ".capybara-plugin/marketplace.json": JSON.stringify({
      schemaVersion: 1,
      name: "Team git (e2e)",
      owner: { name: "Acme" },
      plugins: Object.entries(commits).map(([version, commit]) => ({
        name: "notes",
        version,
        summary: { en: `Notes ${version}`, zh: `笔记 ${version}` },
        source: { git: { url: git.url("notes"), commit } },
      })),
    }),
  });
  return { url: git.url("marketplace"), stop: () => git.stop() };
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
    bootstrap: join(logDir, "pack-bootstrap.log"),
    kernel: join(logDir, "kernel.log"),
    web: join(logDir, "web.log"),
  };
  try {
    const { startTestS3 } = (await import(containersModule)) as { startTestS3: StartTestS3 };
    const [pg, valkey, s3] = await Promise.all([
      new PostgreSqlContainer("postgres:17").start(),
      new GenericContainer("valkey/valkey:8")
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
        .start(),
      startTestS3(),
    ]);
    cleanups.push(async () => {
      await Promise.all([pg.stop(), valkey.stop(), s3.stop()]);
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
        {
          name: "verify",
          description: "Ask the user to verify their email on a web page.",
          annotations: { readOnlyHint: true },
          handler: async (_info, ctx) => {
            const r = await ctx.elicit({
              mode: "url",
              message: "Verify your email",
              url: "https://example.com/verify?token=e2e",
              elicitationId: "verify-1",
            });
            return { content: [{ type: "text", text: `verify ${r.action}` }] };
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

    const openapi = await startPetsApi(OPENAPI_KEY);
    cleanups.push(() => openapi.stop());

    // Catalog: a fake npm registry (plugins crm-core and crm) + a fake official marketplace
    // (marketplace.json with both, plus a git entry)
    const catalogFixtures = await startCatalogFixtures(mcp.url);
    cleanups.push(() => catalogFixtures.stop());
    // A git marketplace (added in the admin console by the upgrade case)
    const gitMarketplace = await startGitMarketplace();
    cleanups.push(() => gitMarketplace.stop());

    const [kernelPort, webPort] = [await freePort(), await freePort()];
    const configFile = join(dir, "capybara.yaml");
    const config = {
      db: { url: pg.getConnectionUri() },
      redis: { url: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}` },
      masterKey: randomBytes(32).toString("base64"),
      extensions: [
        modelFake,
        fakeConnector,
        fakeOpenApi,
        fakeIm,
        fakeToolsUi,
        fakeEmbed,
        sandboxFake,
        hooksProbe,
      ],
      extensionConfig: {
        // fake-1 声明支持图片与文档：上传附件用例核对模型收到的是 image 块（不是文字占位）
        // fake-2: the model the conversation page switches to (conversation-capabilities.spec.ts)
        "model-fake": {
          models: [{ id: "fake-1", vision: true, documents: true }, { id: "fake-2" }],
        },
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
        "sandbox-fake": { root: join(dir, "sandboxes") },
        "fake-connector": { allowInsecureLoopback: true, kind: "mcp" },
        "fake-openapi": { allowInsecureLoopback: true },
        "fake-im": {
          platformUrl: "http://127.0.0.1:9",
          clientId: "e2e-login",
          clientSecret: "e2e-login-secret",
        },
      },
      // The official marketplace points at the fake one; extension packages and plugins download
      // from the fake npm registry (all local http)
      packages: { npmRegistry: catalogFixtures.registryUrl },
      marketplaces: {
        official: { enabled: true, url: catalogFixtures.marketplaceUrl },
        allowInsecureLoopback: true,
        // git and archive entries only from the local fakes (crm-next on github.com is listed as
        // not importable)
        allowedHosts: ["127.0.0.1"],
      },
      // e2e approves extension permissions automatically (off by default in production)
      extensionPermissions: { autoApprove: true },
      // Extension packages installed from the admin console unpack into a temp dir (the default
      // /var/lib/capybara/plugins is not writable on a dev machine)
      extensionHost: { dir: join(dir, "plugins") },
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

    const migrate = run(
      process.execPath,
      [cli, "--no-env-file", "migrate"],
      kernelEnv,
      logs.migrate,
    );
    if ((await exited(migrate)) !== 0) {
      throw new Error(`capybara migrate failed:\n${await tail(logs.migrate)}`);
    }

    // The bootstrap packages, as the image bakes them into /app/bootstrap: the pinned npm packages
    // from the public registry (or the mirror in CAPYBARA_PACKAGES__NPM_REGISTRY), never the fake
    // catalog registry above
    const bootstrapDir = join(dir, "bootstrap");
    const pack = run(
      "pnpm",
      ["-s", "pack-bootstrap", "--registry", BOOTSTRAP_REGISTRY, "--out", bootstrapDir],
      { INIT_CWD: repoRoot },
      logs.bootstrap,
    );
    if ((await exited(pack)) !== 0) {
      throw new Error(`pnpm pack-bootstrap failed:\n${await tail(logs.bootstrap)}`);
    }

    const kernel = run(
      process.execPath,
      [cli, "--no-env-file", "start", "--bootstrap-dir", bootstrapDir],
      kernelEnv,
      logs.kernel,
    );
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
    // The kernel itself (extension routes such as /plugins/hooks-probe/config are not proxied)
    process.env.CAPYBARA_E2E_KERNEL_URL = `http://127.0.0.1:${kernelPort}`;
    process.env.CAPYBARA_E2E_OPENAPI_SPEC_URL = openapi.specUrl;
    process.env.CAPYBARA_E2E_OPENAPI_KEY = OPENAPI_KEY;
    process.env.CAPYBARA_E2E_GIT_MARKETPLACE_URL = gitMarketplace.url;
    const { greeterPkg } = (await import(pluginPackagesModule)) as {
      greeterPkg: () => Promise<Uint8Array>;
    };
    const greeterTgz = join(dir, "greeter-1.0.0.tgz");
    await writeFile(greeterTgz, await greeterPkg());
    process.env.CAPYBARA_E2E_GREETER_TGZ = greeterTgz;
    console.log(`[e2e] kernel :${kernelPort}, web ${baseUrl}, logs in ${logDir}`);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return cleanup;
}
