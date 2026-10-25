import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The parent's environment without any CAPYBARA_* variable. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return env;
}

/** Runs `pnpm capybara <args>` from the repository root with `env`, writing `stdin` and closing it. */
export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env,
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

/**
 * The bootstrap directory the image bakes, made the same way (`pnpm pack-bootstrap`: every entry of
 * packages/kernel/bootstrap.json packed from the workspace and checked against its pin) in a fresh
 * temporary directory, which the caller removes.
 */
export async function packBootstrapDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "capybara-bootstrap-"));
  await promisify(execFile)("pnpm", ["-s", "pack-bootstrap", "--out", dir], {
    cwd: REPO_ROOT,
    env: { ...process.env, INIT_CWD: REPO_ROOT },
    timeout: 120_000,
  });
  return dir;
}
