import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeExtensionDir, packFixture } from "@capybara-hq/testing";

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

/** An npm entry of a bootstrap manifest (the CLI depends on the kernel only, not on the SDK). */
export interface BootstrapEntry {
  name: string;
  source: "npm";
  npm: string;
  version: string;
  integrity: string;
  required: boolean;
}

/** The file name of an entry's tgz in the bootstrap directory (SDK `bootstrapFileName`). */
export const bootstrapFileName = (e: { name: string; version: string }) =>
  `${e.name}-${e.version}.tgz`;

/**
 * The fakes the CLI tests bootstrap instead of the real pins: a model provider that needs a secret
 * (like openai-compatible) and an S3 object store without migrations (like object-store-s3; the
 * CLI uses only an object store whose setup needs nothing a replica must run first).
 */
export const BOOTSTRAP_FAKES = ["fake-bootstrap-a", "fake-object-store"] as const;

/** An offline bootstrap directory of packed fakes and the manifest that pins them. */
export interface FakeBootstrapDir {
  /** The directory `capybara bootstrap --dir` reads (`<name>-<version>.tgz` per entry). */
  dir: string;
  /** `<dir>/bootstrap.json`, for `--manifest`. */
  manifest: string;
  /** The manifest's entries (npm pins, as the real manifest has). */
  entries: BootstrapEntry[];
}

/**
 * An offline bootstrap directory (`bootstrap.dir`), made from the fakes of
 * `@capybara-hq/testing` instead of the real pins (core tests never download published plugins):
 * each fake packed with the plugin packer (`packFixture`) and pinned by its sha512 in an npm entry
 * of `<dir>/bootstrap.json`. The real manifest is exercised by the web e2e setup and the docker
 * smoke tests, which download its pins. The caller removes the directory.
 */
export async function packFakeBootstrapDir(): Promise<FakeBootstrapDir> {
  const dir = await mkdtemp(join(tmpdir(), "capybara-bootstrap-"));
  const entries: BootstrapEntry[] = [];
  const staging = await mkdtemp(join(tmpdir(), "capybara-bootstrap-pack-"));
  try {
    for (const name of BOOTSTRAP_FAKES) {
      const packed = await packFixture(name, staging);
      const pkg = JSON.parse(
        await readFile(join(fakeExtensionDir(name), "package.json"), "utf8"),
      ) as { name: string; version: string };
      const entry: BootstrapEntry = {
        name,
        source: "npm",
        npm: pkg.name,
        version: pkg.version,
        integrity: `sha512-${createHash("sha512").update(packed.bytes).digest("base64")}`,
        required: true,
      };
      await writeFile(join(dir, bootstrapFileName(entry)), packed.bytes);
      entries.push(entry);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const manifest = join(dir, "bootstrap.json");
  await writeFile(manifest, JSON.stringify(fakeManifest(entries), null, 2));
  return { dir, manifest, entries };
}

/** A bootstrap manifest of `entries` (npm entries need the marketplace commit; never read here). */
export function fakeManifest(entries: BootstrapEntry[]) {
  return {
    schemaVersion: 1,
    marketplace: { url: "https://github.com/capybara-hq/plugins.git", commit: "0".repeat(40) },
    plugins: entries,
  };
}
