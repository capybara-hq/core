import {
  KernelConfigSchema,
  type KernelLogger,
  loadConfig,
  rewrapMasterKeys,
  secretValues,
} from "@capybara-hq/kernel";

/** The output streams of `secrets rewrap` (replaceable in tests). */
export interface SecretsIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * `capybara secrets rewrap`: after a master key rotation (new `masterKey`, the old one moved to
 * `masterKeyPrevious`), rewraps every org data key and every unexpired initial password still
 * sealed with a previous master key with the current one, in batches; prints the counts. Only
 * PostgreSQL is used. Idempotent: a re-run rewraps nothing. Prints key ids (hash prefixes), never
 * a key; the configured keys are registered with the logger as secrets before anything runs.
 * Exit code 0 on success, 1 on failure (a master key in use that the config lacks, a database
 * error); a failed run leaves every finished batch done, so it can simply be run again.
 */
export async function runSecretsRewrap(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: SecretsIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    const r = await rewrapMasterKeys(config, { logger: log });
    io.stdout.write(
      `rewrapped ${r.dataKeys} org data key(s) and ${r.initialPasswords} initial password(s) ` +
        `to master key ${r.currentMasterKeyId}\n`,
    );
    if (config.masterKeyPrevious.length > 0) {
      io.stdout.write(
        "every org data key and unexpired initial password now uses the current master key " +
          "(expired initial passwords are left to their cleanup); once every replica runs this " +
          "config, wait auth.accessTokenTtlSeconds, then remove masterKeyPrevious " +
          "(docs/deploy/README.md, Rotating the master key)\n",
      );
    }
    return 0;
  } catch (e) {
    io.stderr.write(
      `capybara: secrets rewrap failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}
