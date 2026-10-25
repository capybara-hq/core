import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packBootstrap } from "./bootstrap.js";
import { packPlugin } from "./pack.js";

/**
 * 用法：
 *   pnpm pack-plugin <plugin-dir> [--out <dir>]   打一个插件
 *   pnpm pack-plugins [--out <dir>]               打 plugins/* 下全部官方插件
 *   pnpm pack-bootstrap [--out <dir>]             the bootstrap directory the image bakes: every
 *                                                 entry of packages/kernel/bootstrap.json as
 *                                                 <name>-<version>.tgz, checked against its pins
 *                                                 (`--bootstrap <manifest>`; see bootstrap.ts)
 * 默认输出到仓库根的 `artifacts/plugins`（--bootstrap: `artifacts/bootstrap`）。相对路径按调用 pnpm 时的目录解析。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cwd = process.env.INIT_CWD ?? process.cwd();

const args = process.argv.slice(2);
let out: string | undefined;
let all = false;
let bootstrap: string | undefined;
const dirs: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--out") {
    const v = args[++i];
    if (v === undefined) usage("--out needs a directory");
    out = resolve(cwd, v as string);
  } else if (a === "--all") all = true;
  else if (a === "--bootstrap") {
    const v = args[++i];
    if (v === undefined) usage("--bootstrap needs a manifest file");
    bootstrap = resolve(cwd, v as string);
  } else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else dirs.push(resolve(cwd, a));
}

function usage(msg: string): never {
  console.error(
    `${msg}\n用法：pnpm pack-plugin <plugin-dir> [--out <dir>] | pnpm pack-plugins [--out <dir>] | pnpm pack-bootstrap [--out <dir>]`,
  );
  process.exit(2);
}

if (bootstrap !== undefined) {
  if (all || dirs.length > 0) usage("--bootstrap takes no plugin directory");
  try {
    for (const p of await packBootstrap(
      bootstrap,
      root,
      out ?? join(root, "artifacts/bootstrap"),
    )) {
      console.log(`${relative(root, p.file)}  ${p.integrity}`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

if (all) {
  const base = join(root, "plugins");
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(base, e.name, "package.json"))) {
      dirs.push(join(base, e.name));
    }
  }
  dirs.sort();
}
if (dirs.length === 0) usage("no plugin directory given");

let failed = 0;
for (const dir of dirs) {
  try {
    const r = await packPlugin(dir, out ?? join(root, "artifacts/plugins"));
    console.log(`${relative(root, r.file)}  sha256=${r.sha256}`);
    for (const d of r.dropped) {
      console.warn(`${relative(root, dir)}: warning: "files" entry "${d}" is not in the package`);
    }
  } catch (e) {
    failed++;
    console.error(`${relative(root, dir)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} 个插件打包失败`);
  process.exit(1);
}
