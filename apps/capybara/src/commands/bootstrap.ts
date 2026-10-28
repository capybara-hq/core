import { resolve } from "node:path";
import {
  BOOTSTRAP_MANIFEST_FILE,
  type BootstrapEntryResult,
  BootstrapFailedError,
  bootstrapManifestSha256,
  type KernelLogger,
  openCatalogCli,
  readBootstrapManifest,
} from "@capybara-hq/kernel";
import { withOpened } from "./extensions.js";

/**
 * The offline bootstrap directory: `given` (`capybara bootstrap --dir`), else the config key
 * `bootstrap.dir` (default `bootstrap`), resolved against the working directory (`./bootstrap` in a
 * source checkout, `/app/bootstrap` in the image).
 */
export function bootstrapDirOf(
  config: { bootstrap: { dir: string } },
  given?: string,
  cwd: string = process.cwd(),
): string {
  return resolve(cwd, given ?? config.bootstrap.dir);
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

/**
 * `capybara bootstrap [--dir <path>] [--manifest <path>]` (package ecosystem spec §7, startup
 * bootstrap spec): installs the plugins the bootstrap manifest pins (default: the `bootstrap.json`
 * shipped with the kernel), each from a `*.tgz` of the offline directory whose sha512 matches
 * (`--dir`, else config `bootstrap.dir`, see {@link bootstrapDirOf}; it may be missing), else
 * downloaded from `packages.npmRegistry`. Runs the kernel migrations first; the step itself is
 * `BootstrapService` (every package obtained and checked before anything is written, under the
 * Redis lock `lock:bootstrap` shared with starting kernels, so this command needs Redis; done once
 * per manifest). Prints what it did per plugin; a
 * re-run for the same manifest does nothing. When only optional entries failed, it opens the CLI
 * context again and runs once more (a declarative entry's catalog files need the object store,
 * which on a fresh deployment is itself a bootstrap plugin installed by the first pass). Running
 * replicas pick the new install records up through `kernel.plugins.changed` (published by the
 * install and enable operations).
 *
 * Exit code 0 when the step is done, and also when after the second pass only optional entries
 * still fail: those are printed as warnings, nothing is recorded as done (the next `bootstrap` or
 * `start` retries them), and the deployment can serve, as `capybara start` would (it refuses only
 * for required entries). Exit code 1 when a required entry fails, a package cannot be obtained
 * (missing, download failed, or not matching its pin: nothing is written then), or anything else
 * goes wrong.
 */
export async function runBootstrap(
  opts: { dir?: string; manifest?: string },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: BootstrapIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
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
        if (carry === undefined && (await cli.bootstrap.isDone(sha))) return "done" as const;
        const dir = bootstrapDirOf(cli.config, opts.dir);
        return (
          await cli.bootstrap.run({
            manifest,
            dir,
            imports: cli.imports,
            ...(carry !== undefined && { carry }),
          })
        ).results;
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
      try {
        results = await pass(e.results);
      } catch (e2) {
        if (!(e2 instanceof BootstrapFailedError) || e2.requiredFailed) throw e2;
        for (const r of e2.results) {
          io.stdout.write(`${r.name} ${r.version}: ${ACTION_TEXT[r.action]}\n`);
        }
        for (const f of e2.failures) {
          io.stderr.write(`capybara: bootstrap: warning: ${f.name}: ${f.message}\n`);
        }
        io.stderr.write(
          "capybara: bootstrap: warning: optional plugins could not be installed; the required ones are, so the deployment can serve. Nothing is recorded as done: the next bootstrap or start retries them\n",
        );
        return 0;
      }
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
