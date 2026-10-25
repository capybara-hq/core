import { existsSync } from "node:fs";
import {
  BOOTSTRAP_MANIFEST_FILE,
  type BootstrapEntryResult,
  BootstrapFailedError,
  BootstrapService,
  bootstrapManifestSha256,
  type CatalogCli,
  type KernelLogger,
  openCatalogCli,
  readBootstrapManifest,
} from "@capybara-hq/kernel";
import { withOpened } from "./extensions.js";

/**
 * Where the image keeps the bootstrap packages (`<name>-<version>.tgz`, packed and checked
 * against `bootstrap.json` at image build time; see docker/kernel.Dockerfile).
 */
export const DEFAULT_BOOTSTRAP_DIR = "/app/bootstrap";

/**
 * The bootstrap directory `capybara start` passes to the kernel: the one given, else the image's
 * default when it exists (a kernel that finds bootstrap not done runs it itself, for deployments
 * without the init container), else none (running from source: no bootstrap step).
 */
export function startBootstrapDir(
  given: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (given !== undefined) return given;
  return exists(DEFAULT_BOOTSTRAP_DIR) ? DEFAULT_BOOTSTRAP_DIR : undefined;
}

export interface BootstrapIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ACTION_TEXT: Record<BootstrapEntryResult["action"], string> = {
  installed: "installed",
  upgraded: "upgraded",
  kept: "kept",
  imported: "imported into the catalog",
  required_cleared: "no longer required",
};

const serviceOf = (cli: CatalogCli, log: KernelLogger) => {
  const declared = new Set(cli.inspected.map((p) => p.manifest.name));
  return new BootstrapService({
    db: cli.db,
    dbUrl: cli.config.db.url,
    connectTimeoutMs: cli.config.db.connectTimeoutMs,
    config: () => cli.config,
    imports: cli.imports,
    installs: cli.installs,
    ops: cli.ops,
    declared: () => declared,
    log,
  });
};

/**
 * `capybara bootstrap [--dir <path>] [--manifest <path>]` (package ecosystem spec §7): installs the
 * plugins the bootstrap manifest pins (default: the `bootstrap.json` shipped with the kernel) from
 * the packages in `dir` (default {@link DEFAULT_BOOTSTRAP_DIR}), never from the network. Runs the
 * kernel migrations first; the step itself is `BootstrapService` (sha512 check of every file before
 * anything is written, advisory lock, done once per manifest). Prints what it did per plugin; a
 * re-run for the same manifest does nothing. When only optional entries failed, it opens the CLI
 * context again and runs once more (a declarative entry's catalog files need the object store,
 * which on a fresh deployment is itself a bootstrap plugin installed by the first pass). Running
 * replicas pick the new install records up through `kernel.plugins.changed` (published by the
 * install and enable operations). Exit code 0 when the
 * step is done, 1 otherwise.
 */
export async function runBootstrap(
  opts: { dir?: string; manifest?: string },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: BootstrapIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const dir = opts.dir ?? DEFAULT_BOOTSTRAP_DIR;
  let manifest: Awaited<ReturnType<typeof readBootstrapManifest>>;
  try {
    manifest = await readBootstrapManifest(opts.manifest ?? BOOTSTRAP_MANIFEST_FILE);
  } catch (e) {
    io.stderr.write(`capybara: bootstrap failed: ${errMsg(e)}\n`);
    return 1;
  }
  const sha = bootstrapManifestSha256(manifest);
  const pass = (carry?: BootstrapEntryResult[]) =>
    withOpened(
      log,
      env,
      (config) => openCatalogCli(config, log),
      async (cli) => {
        const service = serviceOf(cli, log);
        if (carry === undefined && (await service.isDone(sha))) return "done" as const;
        return (await service.run({ manifest, dir, ...(carry !== undefined && { carry }) }))
          .results;
      },
    );
  try {
    let results: BootstrapEntryResult[] | "done";
    try {
      results = await pass();
    } catch (e) {
      if (!(e instanceof BootstrapFailedError) || e.requiredFailed) throw e;
      log.warn("bootstrap: optional plugins could not be installed yet; trying once more", {
        failures: e.failures,
      });
      results = await pass(e.results);
    }
    if (results === "done") {
      io.stdout.write(
        `Bootstrap already done for this manifest (sha256 ${sha.slice(0, 12)}); nothing to do.\n`,
      );
      return 0;
    }
    for (const r of results) io.stdout.write(`${r.name} ${r.version}: ${ACTION_TEXT[r.action]}\n`);
    io.stdout.write(`Bootstrap done (manifest sha256 ${sha.slice(0, 12)}).\n`);
    return 0;
  } catch (e) {
    if (e instanceof BootstrapFailedError) {
      for (const f of e.failures) {
        io.stderr.write(
          `capybara: bootstrap: ${f.name}${f.required ? " (required)" : ""}: ${f.message}\n`,
        );
      }
      io.stderr.write("capybara: bootstrap failed; nothing is recorded as done\n");
      return 1;
    }
    io.stderr.write(`capybara: bootstrap failed: ${errMsg(e)}\n`);
    return 1;
  }
}
