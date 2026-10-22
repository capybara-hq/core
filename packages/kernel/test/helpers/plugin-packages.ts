import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { definePlugin, type PluginManifest, staticManifestOf } from "@capybara-hq/plugin-sdk";
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

/** 合法的最小插件包：entry 用 `definePlugin` 导出清单（setup 什么都不做），静态清单与之一致。 */
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
  const real: PluginManifest = definePlugin({
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
      'import { definePlugin } from "@capybara-hq/plugin-sdk";',
      `export default definePlugin({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, sdk: "^0.1.0", provides: [], permissions: {}, setup() {} });`,
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
  /** 包里 `migrations/` 下的 SQL（有就声明 `capybara.migrations`）。 */
  migrations?: { file: string; sql: string }[];
}

/**
 * 生命周期测试用的插件包（默认名 `life`）：一个工具 `wait`，结果为 `<name> <version> done`；路由 `GET /version`
 * 返回版本号（看某个副本此刻跑的是哪个版本）。
 * 部署配置 `dir`（默认空）：
 * - 非空时工具开始执行写 `<dir>/started-<version>-<pid>`，等 `<dir>/release` 出现才返回（跨进程控制，双副本用）；
 *   为空时等同进程的 `globalThis.__lifeGate`（没有就立即返回）；
 * - setup 时 `<dir>/fail-<version>-<pid>` 存在则抛错（只让某个副本的某个版本失败）。
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
  const real: PluginManifest = definePlugin({
    name,
    version: o.version,
    sdk: "^0.1.0",
    provides: provides as never,
    requires: requires as never,
    optional: optional as never,
    permissions: { tools: ["wait"], http: [{ method: "GET", path: "/version" }] },
    config: { deployment: z.object({ dir: z.string().default("") }).default({ dir: "" }) },
    setup() {},
  });
  const entry = `import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const NAME = ${JSON.stringify(name)};
const VERSION = ${JSON.stringify(o.version)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default definePlugin({
  name: NAME,
  version: VERSION,
  sdk: "^0.1.0",
  provides: ${JSON.stringify(provides)},
  requires: ${JSON.stringify(requires)},
  optional: ${JSON.stringify(optional)},
  permissions: { tools: ["wait"], http: [{ method: "GET", path: "/version" }] },
  config: { deployment: z.object({ dir: z.string().default("") }).default({ dir: "" }) },
  async setup(ctx) {
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
    manifest: staticManifestOf(real) as unknown as Record<string, unknown>,
    entry,
    ...(migrations.length > 0 && {
      section: { migrations: "migrations" },
      extra: migrations.map((m) => ({ name: `package/migrations/${m.file}`, data: m.sql })),
    }),
  });
}

/**
 * 用 `tools/pack-plugin` 把仓库里的一个官方插件打成插件包（子进程，避免内核依赖 pack-plugin）。
 * 先把插件复制到临时目录（`node_modules` 链接回原处）再打包：打包的临时文件不落在仓库的插件目录里，
 * 与同时运行的 pack-plugin 测试互不干扰。
 */
export async function packOfficialPlugin(plugin: string): Promise<Uint8Array> {
  const work = await mkdtemp(join(tmpdir(), "kernel-pack-"));
  const src = join(REPO_ROOT, "plugins", plugin);
  const copy = join(work, plugin);
  const out = join(work, "out");
  try {
    await cp(src, copy, {
      recursive: true,
      filter: (from) => !/[/\\](node_modules|dist|test)([/\\]|$)/.test(from.slice(src.length)),
    });
    await symlink(join(src, "node_modules"), join(copy, "node_modules"), "dir");
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
