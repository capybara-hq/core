import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

/**
 * Shared by the tests that build a plugin repository's view of core in a temp directory: core
 * packages under `node_modules` as their npm builds would install them, the workspace's
 * third-party dependencies symlinked next to them, and vitest run inside it as a child process.
 */

const run = promisify(execFile);

/** The repository root. */
export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Symlinks every package of `from` (a node_modules) into `nm`, except `@capybara-hq/*`. */
export async function linkDeps(from: string, nm: string): Promise<void> {
  for (const e of readdirSync(from)) {
    if (e === "@capybara-hq" || e.startsWith(".")) continue;
    const src = join(from, e);
    if (!e.startsWith("@")) {
      if (!existsSync(join(nm, e))) await symlink(await realpath(src), join(nm, e));
      continue;
    }
    await mkdir(join(nm, e), { recursive: true });
    for (const s of readdirSync(src)) {
      if (!existsSync(join(nm, e, s))) await symlink(await realpath(join(src, s)), join(nm, e, s));
    }
  }
}

/** Every non-declaration `.ts` file under `dir`. */
async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * A core library as `tsc -b` and `pnpm pack` would install it: every `src/**\/*.ts` compiled to
 * the same path under `dist/` (one file per source, so `import.meta.url`-relative paths such as the
 * dual-replica runner or the kernel's migrations resolve as in the published package), the
 * `extra` paths of its `files` copied, and a package.json with the `publishConfig.exports`.
 */
export async function installCompiled(
  nm: string,
  name: string,
  pkgDir: string,
  extra: string[] = [],
): Promise<void> {
  const out = join(nm, name);
  const src = join(REPO, pkgDir);
  const pkg = JSON.parse(await readFile(join(src, "package.json"), "utf8")) as {
    version: string;
    publishConfig: { exports: unknown };
  };
  await build({
    entryPoints: await tsFiles(join(src, "src")),
    outdir: join(out, "dist"),
    outbase: join(src, "src"),
    bundle: false,
    platform: "node",
    format: "esm",
    target: "node24",
    tsconfig: join(src, "tsconfig.json"),
    logLevel: "error",
  });
  for (const p of extra) await cp(join(src, p), join(out, p), { recursive: true });
  await writeFile(
    join(out, "package.json"),
    JSON.stringify({
      name,
      version: pkg.version,
      type: "module",
      main: "./dist/index.js",
      exports: pkg.publishConfig.exports,
    }),
  );
}

/** One test of a child vitest run: its title, status and failure messages. */
export interface ChildTest {
  title: string;
  status: string;
  failureMessages: string[];
}

/**
 * Runs vitest inside `dir` with `config` (a file in `dir`) and reads its JSON report (not the
 * console output: under CI it carries colour codes, and its layout is not a contract). `env` is
 * the child's whole environment.
 */
export async function runVitest(
  dir: string,
  config: string,
  env: NodeJS.ProcessEnv = { ...process.env, CI: "" },
): Promise<{ code: number; output: string; tests: ChildTest[] }> {
  const bin = join(REPO, "node_modules/vitest/vitest.mjs");
  const report = join(dir, `report-${relative(dir, config).replaceAll("/", "_")}.json`);
  const args = [bin, "run", "--root", dir, "--config", config, "--reporter=json"];
  args.push(`--outputFile=${report}`);
  let code = 0;
  let output = "";
  try {
    const r = await run(process.execPath, args, { cwd: dir, env });
    output = r.stdout + r.stderr;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    code = err.code ?? 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const json = JSON.parse(await readFile(report, "utf8")) as {
    testResults: { assertionResults: ChildTest[] }[];
  };
  return { code, output, tests: json.testResults.flatMap((f) => f.assertionResults) };
}

/** `{ title: status }` of a child run's tests. */
export const statuses = (tests: ChildTest[]): Record<string, string> =>
  Object.fromEntries(tests.map((t) => [t.title, t.status]));
