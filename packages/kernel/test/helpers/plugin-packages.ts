import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  type BootstrapEntry,
  type BootstrapManifest,
  bootstrapFileName,
  defineExtension,
  type ExtensionManifest,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  SDK_VERSION,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import { pack as tarPack } from "tar-stream";
import { readPluginPackage } from "../../src/catalog/plugin-package.js";

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

/** The extension part of {@link pluginTgz}. */
export interface ExtensionTgzOpts {
  /** Overrides of the static extension manifest (default: that of the default entry). */
  manifest?: Record<string, unknown>;
  /** Additions to / overrides of the extension section (e.g. `{ migrations: "./migrations" }`). */
  section?: Record<string, unknown>;
  /** The entry module's code (replaces the default entry, which exports a no-op defineExtension). */
  entry?: string;
}

/**
 * A valid minimal plugin tgz in the 0.1.0 layout: `.capybara-plugin/plugin.json` (from `manifest`,
 * with `schemaVersion`, `version` 1.0.0, `publisher` and `description` filled in when missing),
 * `package.json` (npm name `packageName`, default `@test/plugin-<name>`) and `files` (paths
 * relative to the package root). With `extension` the plugin has an extension: `dist/index.mjs`
 * (`extension.entry`) exports `defineExtension` with the plugin's name and version, and the static
 * manifest in plugin.json matches it; without it the plugin is declarative (no peerDependencies).
 */
export async function pluginTgz(opts: {
  manifest: Partial<PluginManifest> & { name: string };
  packageName?: string;
  files?: Record<string, string | Uint8Array>;
  extension?: ExtensionTgzOpts;
}): Promise<Uint8Array> {
  const name = opts.manifest.name;
  const version = opts.manifest.version ?? "1.0.0";
  const ext = opts.extension;
  const entries: { name: string; data: string | Buffer }[] = [];
  let extension: Record<string, unknown> | undefined;
  if (ext !== undefined) {
    const real: ExtensionManifest = defineExtension({
      name,
      version,
      sdk: "^0.1.0",
      provides: [],
      permissions: {},
      setup() {},
    });
    extension = {
      entry: "./dist/index.mjs",
      manifest: { ...staticManifestOf(real), ...ext.manifest },
      ...ext.section,
    };
    entries.push({
      name: "package/dist/index.mjs",
      data:
        ext.entry ??
        [
          'import { defineExtension } from "@capybara-hq/plugin-sdk";',
          `export default defineExtension({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, sdk: "^0.1.0", provides: [], permissions: {}, setup() {} });`,
        ].join("\n"),
    });
  }
  const manifest = {
    schemaVersion: 1,
    publisher: "Test",
    description: `Test plugin ${name}`,
    ...opts.manifest,
    version,
    ...(extension !== undefined && { extension }),
  };
  const pkg = {
    name: opts.packageName ?? `@test/plugin-${name}`,
    version,
    type: "module",
    ...(ext !== undefined && {
      peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
    }),
  };
  return tgz([
    { name: "package/package.json", data: JSON.stringify(pkg) },
    { name: `package/${PLUGIN_MANIFEST_FILE}`, data: JSON.stringify(manifest) },
    ...entries,
    ...Object.entries(opts.files ?? {}).map(([path, data]) => ({
      name: `package/${path}`,
      data: typeof data === "string" ? data : Buffer.from(data),
    })),
  ]);
}

/**
 * A tgz in the pre-0.1.0 format (for the rejection tests): an extension package with a `capybara`
 * section in package.json, or with `appYaml` a plugin bundle (`app.yaml`, no `capybara` section).
 * Neither has `.capybara-plugin/plugin.json`.
 */
export async function legacyTgz(
  opts: { name?: string; version?: string; packageName?: string; appYaml?: boolean } = {},
): Promise<Uint8Array> {
  const name = opts.name ?? "legacy-pkg";
  const version = opts.version ?? "1.0.0";
  const packageName = opts.packageName ?? `@test/plugin-${name}`;
  if (opts.appYaml) {
    return tgz([
      { name: "package/package.json", data: JSON.stringify({ name: packageName, version }) },
      {
        name: "package/app.yaml",
        data: `schemaVersion: 1\nname: ${name}\nversion: ${version}\nplugins: []\n`,
      },
    ]);
  }
  const real: ExtensionManifest = defineExtension({
    name,
    version,
    sdk: "^0.1.0",
    provides: [],
    permissions: {},
    setup() {},
  });
  const pkg = {
    name: packageName,
    version,
    type: "module",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
    capybara: {
      kind: "plugin",
      entry: "dist/index.mjs",
      sdk: "^0.1.0",
      manifest: staticManifestOf(real),
    },
  };
  return tgz([
    { name: "package/package.json", data: JSON.stringify(pkg) },
    {
      name: "package/dist/index.mjs",
      data: [
        'import { defineExtension } from "@capybara-hq/plugin-sdk";',
        `export default defineExtension({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, sdk: "^0.1.0", provides: [], permissions: {}, setup() {} });`,
      ].join("\n"),
    },
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
  /** SQL under `migrations/` in the package (declares `extension.migrations` when present). */
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
    manifest: { name, version: o.version },
    ...(o.packageName !== undefined && { packageName: o.packageName }),
    files: Object.fromEntries(migrations.map((m) => [`migrations/${m.file}`, m.sql])),
    extension: {
      manifest: staticManifestOf(real) as unknown as Record<string, unknown>,
      entry,
      ...(migrations.length > 0 && { section: { migrations: "./migrations" } }),
    },
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
    manifest: { name: "greeter", version: "1.0.0" },
    packageName: "@test/plugin-greeter",
    extension: { manifest: staticManifestOf(real) as unknown as Record<string, unknown>, entry },
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
 * Packs any plugin directory in the pack-plugin layout (`package.json` +
 * `.capybara-plugin/plugin.json` + `src/index.ts`, e.g. an official plugin or
 * `test/fixtures/plugins/hooks-probe`) with `tools/pack-plugin` (a child process, so the kernel does
 * not depend on pack-plugin). The directory is copied to a temp directory first (`node_modules`
 * links back to the nearest `node_modules` above the source that has the SDK: an official plugin's
 * own, the kernel package's for kernel fixtures): no temp files land in the repo, and concurrent
 * pack-plugin tests don't interfere. `edit` changes that copy before packing (bump the version in
 * both manifests, add a migration, rename); the source directory is untouched.
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
    manifest: { name: mod.default.name, version: mod.default.version },
    packageName: "@test/plugin-sandbox-fake",
    extension: {
      manifest: staticManifestOf(mod.default) as unknown as Record<string, unknown>,
      entry: stripTypeScriptTypes(source, { mode: "strip" }),
    },
  });
}

/** One package of {@link bootstrapFixture}: bytes, or a plugin directory packed with pack-plugin. */
export interface BootstrapFixtureEntry {
  /** A plugin tgz (e.g. from {@link pluginTgz} / {@link lifePkg}). */
  bytes?: Uint8Array;
  /** A plugin directory in the pack-plugin layout, packed with {@link packPluginDir}. */
  dir?: string;
  required?: boolean;
}

/**
 * A bootstrap directory and its manifest, as the image would carry them: each package written as
 * `<name>-<version>.tgz` into a fresh temp directory, and a manifest pinning each by sha512
 * (`source: "workspace"`, `path: plugins/<name>`; `required` defaults to true). Pass the result
 * as `bootstrap` to the dual-replica harness or as `bootstrapDir` / `bootstrapManifest` to
 * `createKernel`; `cleanup` removes the directory.
 */
export async function bootstrapFixture(entries: BootstrapFixtureEntry[]): Promise<{
  dir: string;
  manifest: BootstrapManifest;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "kernel-bootstrap-"));
  const plugins: BootstrapEntry[] = [];
  for (const e of entries) {
    const bytes = e.bytes ?? (await packPluginDir(e.dir as string));
    const { manifest } = await readPluginPackage(bytes, {
      maxBytes: 64 * 1024 * 1024,
      hostSdkVersion: SDK_VERSION,
    });
    const entry: BootstrapEntry = {
      name: manifest.name,
      source: "workspace",
      // Only check:bootstrap reads `path` (the kernel installs from `dir`); not a plugin load
      path: ["plugins", manifest.name].join("/"),
      version: manifest.version,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      required: e.required ?? true,
    };
    await writeFile(join(dir, bootstrapFileName(entry)), bytes);
    plugins.push(entry);
  }
  return {
    dir,
    manifest: { schemaVersion: 1, plugins },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
