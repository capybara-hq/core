import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { defineExtension, type ExtensionManifest, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { pack as tarPack } from "tar-stream";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** 用 tar-stream 拼一个 gzip 后的 tar（文件条目都在 `package/` 下由调用方写明）。 */
export async function tgz(entries: { name: string; data: string | Buffer }[]): Promise<Uint8Array> {
  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const c of p) chunks.push(c as Buffer);
  })();
  for (const e of entries) {
    const data = Buffer.from(e.data);
    await new Promise<void>((res, rej) =>
      p.entry({ name: e.name, type: "file", mode: 0o644, size: data.length }, data, (err) =>
        err ? rej(err) : res(),
      ),
    );
  }
  p.finalize();
  await done;
  return new Uint8Array(gzipSync(Buffer.concat(chunks)));
}

/** 合法的最小插件包：entry 用 `defineExtension` 导出清单（setup 什么都不做），静态清单与之一致。 */
export async function pluginTgz(
  opts: {
    name?: string;
    version?: string;
    packageName?: string;
    /** 附加到 package.json 的 `capybara` 段 / 改写静态清单。 */
    section?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    extra?: { name: string; data: string }[];
    /** 写进 entry 的模块代码（替换默认 entry）。 */
    entry?: string;
  } = {},
): Promise<Uint8Array> {
  const name = opts.name ?? "demo-pkg";
  const version = opts.version ?? "1.0.0";
  const real: ExtensionManifest = defineExtension({
    name,
    version,
    sdk: "^0.1.0",
    provides: [],
    permissions: {},
    setup() {},
  });
  const entry =
    opts.entry ??
    [
      'import { defineExtension } from "@capybara-hq/plugin-sdk";',
      `export default defineExtension({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, sdk: "^0.1.0", provides: [], permissions: {}, setup() {} });`,
    ].join("\n");
  const pkg = {
    name: opts.packageName ?? `@test/plugin-${name}`,
    version,
    type: "module",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
    capybara: {
      kind: "plugin",
      entry: "dist/index.mjs",
      sdk: "^0.1.0",
      manifest: { ...staticManifestOf(real), ...opts.manifest },
      ...opts.section,
    },
  };
  return tgz([
    { name: "package/package.json", data: JSON.stringify(pkg) },
    { name: "package/dist/index.mjs", data: entry },
    ...(opts.extra ?? []),
  ]);
}

/** {@link lifePkg} 的选项。 */
export interface LifePkgOptions {
  name?: string;
  version: string;
  provides?: string[];
  requires?: string[];
  optional?: string[];
  /** package.json 的 npm 包名（默认 `@test/plugin-<name>`）。 */
  packageName?: string;
  /** 包里 `migrations/` 下的 SQL（有就声明 `capybara.migrations`）。 */
  migrations?: { file: string; sql: string }[];
  /**
   * A `tool.preExecute` policy hook (declared in `permissions.hooks` / `policyHooks`): input
   * `{ hold: true }` waits on `globalThis.__lifeGate`; input `{ deny: true }` denies with
   * `<name> <version> denies`; anything else is allowed.
   */
  policy?: boolean;
}

/**
 * 生命周期测试用的插件包（默认名 `life`）：一个工具 `wait`，结果为 `<name> <version> done`；路由 `GET /version`
 * 返回版本号（看某个副本此刻跑的是哪个版本）。
 * 部署配置 `dir`（默认空）：
 * - 非空时工具开始执行写 `<dir>/started-<version>-<pid>`，等 `<dir>/release` 出现才返回（跨进程控制，双副本用）；
 *   为空时等同进程的 `globalThis.__lifeGate`（没有就立即返回）；
 * - setup 时 `<dir>/fail-<version>-<pid>` 存在则抛错（只让某个副本的某个版本失败）。
 * 模块顶层把 `<name> <version>` 记进 `globalThis.__lifeImports`（批准之前不得导入）。
 * 提供的能力实现为 `{ from: <name>, version }`；`connector@1` 为一个最小连接器（`open` 等 `globalThis.__lifeGate`）。每次 setup 在 `globalThis.__lifeSetups[<name>]` 记一笔（同进程测试用）。
 */
export async function lifePkg(o: LifePkgOptions): Promise<Uint8Array> {
  const name = o.name ?? "life";
  const provides = o.provides ?? [];
  const requires = o.requires ?? [];
  const optional = o.optional ?? [];
  const spec = {
    name: "wait",
    description: "Waits until the test releases it, then returns. Test fixture only.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  };
  const { z } = await import("zod");
  const perms = {
    tools: ["wait"],
    http: [{ method: "GET" as const, path: "/version" }],
    ...(o.policy && {
      hooks: ["tool.preExecute" as const],
      policyHooks: ["tool.preExecute" as const],
    }),
  };
  const real: ExtensionManifest = defineExtension({
    name,
    version: o.version,
    sdk: "^0.1.0",
    provides: provides as never,
    requires: requires as never,
    optional: optional as never,
    permissions: perms,
    config: { deployment: z.object({ dir: z.string().default("") }).default({ dir: "" }) },
    setup() {},
  });
  const entry = `import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const NAME = ${JSON.stringify(name)};
const VERSION = ${JSON.stringify(o.version)};
// 模块顶层代码：记一笔导入（测试「批准之前不执行插件代码」）
(globalThis.__lifeImports ??= []).push(NAME + " " + VERSION);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default defineExtension({
  name: NAME,
  version: VERSION,
  sdk: "^0.1.0",
  provides: ${JSON.stringify(provides)},
  requires: ${JSON.stringify(requires)},
  optional: ${JSON.stringify(optional)},
  permissions: ${JSON.stringify(perms)},
  config: { deployment: z.object({ dir: z.string().default("") }).default({ dir: "" }) },
  async setup(ctx) {
    if (${JSON.stringify(o.policy === true)}) {
      ctx.hooks.on(
        "tool.preExecute",
        async (p) => {
          if (p.input?.hold && globalThis.__lifeGate) await globalThis.__lifeGate;
          return p.input?.deny ? { deny: NAME + " " + VERSION + " denies" } : undefined;
        },
        { mode: "policy" },
      );
    }
    const dir = ctx.config.dir;
    if (dir && existsSync(join(dir, "fail-" + VERSION + "-" + process.pid))) {
      throw new Error("setup failure requested by the test");
    }
    globalThis.__lifeSetups ??= {};
    globalThis.__lifeSetups[NAME] = [...(globalThis.__lifeSetups[NAME] ?? []), VERSION];
    // connector@1：open 等同进程的 globalThis.__lifeGate，返回一个会话（测试提供方调用的在途计数）
    const connector = {
      kind: NAME,
      async open() {
        if (globalThis.__lifeGate) await globalThis.__lifeGate;
        return {
          async listTools() { return []; },
          async callTool() { return { content: [{ type: "text", text: NAME + " " + VERSION }] }; },
          async close() {},
        };
      },
    };
    for (const cap of ${JSON.stringify(provides)}) {
      ctx.provide(cap, cap === "connector@1" ? connector : { from: NAME, version: VERSION });
    }
    ctx.http.route("GET", "/version", async () => new Response(VERSION));
    ctx.tools.register(${JSON.stringify(spec)}, async () => {
      if (dir) {
        writeFileSync(join(dir, "started-" + VERSION + "-" + process.pid), "");
        while (!existsSync(join(dir, "release"))) await sleep(20);
      } else if (globalThis.__lifeGate) {
        await globalThis.__lifeGate;
      }
      return { content: [{ type: "text", text: NAME + " " + VERSION + " done" }] };
    });
  },
});
`;
  const migrations = o.migrations ?? [];
  return pluginTgz({
    name,
    version: o.version,
    ...(o.packageName !== undefined && { packageName: o.packageName }),
    manifest: staticManifestOf(real) as unknown as Record<string, unknown>,
    entry,
    ...(migrations.length > 0 && {
      section: { migrations: "migrations" },
      extra: migrations.map((m) => ({ name: `package/migrations/${m.file}`, data: m.sql })),
    }),
  });
}

/**
 * The extension package `greeter` 1.0.0 used by the web e2e (`apps/web/e2e/admin-extensions.spec.ts`):
 * tool `greet` returns `<greeting> from greeter`; deployment config `greeting` (hot, default `hello`)
 * and an optional secret `token`. Tools are a sensitive permission, so the install confirmation needs
 * "I understand the sensitive items" checked.
 */
export async function greeterPkg(): Promise<Uint8Array> {
  const { z } = await import("zod");
  const { secret } = await import("@capybara-hq/plugin-sdk");
  const permissions = { tools: ["greet"] };
  const real: ExtensionManifest = defineExtension({
    name: "greeter",
    version: "1.0.0",
    sdk: "^0.1.0",
    provides: [],
    permissions,
    config: {
      deployment: z.object({
        greeting: z.string().default("hello").meta({ hot: true }),
        token: secret(z.string()).optional(),
      }),
    },
    setup() {},
  });
  const spec = {
    name: "greet",
    description: "Returns the configured greeting. Test fixture only.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  };
  const entry = `import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
export default defineExtension({
  name: "greeter",
  version: "1.0.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: ${JSON.stringify(permissions)},
  config: {
    deployment: z.object({
      greeting: z.string().default("hello").meta({ hot: true }),
      token: secret(z.string()).optional(),
    }),
  },
  setup(ctx) {
    ctx.tools.register(${JSON.stringify(spec)}, async () => ({
      content: [{ type: "text", text: ctx.config.greeting + " from greeter" }],
    }));
  },
});
`;
  return pluginTgz({
    name: "greeter",
    version: "1.0.0",
    packageName: "@test/plugin-greeter",
    manifest: staticManifestOf(real) as unknown as Record<string, unknown>,
    entry,
  });
}

/**
 * 用 `tools/pack-plugin` 把仓库里的一个官方插件（`plugins/<plugin>`）打成插件包，见 {@link packPluginDir}。
 */
export async function packOfficialPlugin(
  plugin: string,
  edit?: (dir: string) => Promise<void>,
): Promise<Uint8Array> {
  return packPluginDir(join(REPO_ROOT, "plugins", plugin), edit);
}

/**
 * 用 `tools/pack-plugin` 把任意插件目录（pack-plugin 布局：`package.json` + `src/index.ts`，如官方插件或
 * `test/fixtures/plugins/hooks-probe`）打成插件包（子进程，避免内核依赖 pack-plugin）。
 * 先把目录复制到临时目录再打包（`node_modules` 链接回离源目录最近、装有 SDK 的那个 `node_modules`：官方插件是
 * 它自己的，内核测试夹具是内核包的）：打包的临时文件不落在仓库里，与同时运行的 pack-plugin 测试互不干扰。
 * `edit` 在打包前改这份副本（如升版本、加迁移、改名），仓库里的源目录不动。
 */
export async function packPluginDir(
  src: string,
  edit?: (dir: string) => Promise<void>,
): Promise<Uint8Array> {
  const work = await mkdtemp(join(tmpdir(), "kernel-pack-"));
  const copy = join(work, basename(src));
  const out = join(work, "out");
  try {
    await cp(src, copy, {
      recursive: true,
      filter: (from) => !/[/\\](node_modules|dist|test)([/\\]|$)/.test(from.slice(src.length)),
    });
    await symlink(nodeModulesFor(src), join(copy, "node_modules"), "dir");
    await edit?.(copy);
    await promisify(execFile)("pnpm", ["-s", "pack-plugin", copy, "--out", out], {
      cwd: REPO_ROOT,
      env: { ...process.env, INIT_CWD: REPO_ROOT },
      timeout: 120_000,
    });
    const files = (await readdir(out)).filter((f) => f.endsWith(".tgz"));
    if (files.length !== 1) throw new Error(`pack-plugin produced ${files.length} packages`);
    return new Uint8Array(await readFile(join(out, files[0] as string)));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 从 `dir` 向上找第一个装有 `@capybara-hq/plugin-sdk` 的 `node_modules`。 */
function nodeModulesFor(dir: string): string {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const nm = join(d, "node_modules");
    if (existsSync(join(nm, "@capybara-hq", "plugin-sdk"))) return nm;
    if (dirname(d) === d) throw new Error(`no node_modules with the plugin SDK above ${dir}`);
  }
}

const SANDBOX_FAKE_SRC = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

/**
 * 测试用 `sandbox@1` 插件 `sandbox-fake`（`test/fixtures/plugins/sandbox-fake`，部署配置 `{ root }`）打成的插件包：
 * entry 是去掉类型标注后的同一份源码（只 import `node:*`、SDK 与 zod），静态清单取自真实模块。
 * 提供 `sandbox@1`，安装确认页标敏感。
 */
export async function sandboxFakePkg(): Promise<Uint8Array> {
  const { stripTypeScriptTypes } = await import("node:module");
  const source = await readFile(SANDBOX_FAKE_SRC, "utf8");
  const mod = (await import(SANDBOX_FAKE_SRC)) as { default: ExtensionManifest };
  return pluginTgz({
    name: mod.default.name,
    version: mod.default.version,
    packageName: "@test/plugin-sandbox-fake",
    manifest: staticManifestOf(mod.default) as unknown as Record<string, unknown>,
    entry: stripTypeScriptTypes(source, { mode: "strip" }),
  });
}
