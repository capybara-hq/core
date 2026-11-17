import type { KernelConfig } from "../../config/schema.js";
import { type Keyring, type RewrapResult, rewrapToCurrentMasterKey } from "../../ctx/secrets.js";
import type { KernelLogger } from "../../log.js";
import { KernelDb } from "../database/kernel-db.js";
import { TransactionHost } from "../database/transaction-host.js";
import { KEYRING } from "../tokens.js";
import { openKernelCli } from "./kernel-cli.module.js";

/**
 * `capybara secrets rewrap`: opens a PostgreSQL-only CLI context over `config` (its keyring is
 * `masterKey` plus `masterKeyPrevious`) and rewraps everything sealed with a previous master key
 * with the current one ({@link rewrapToCurrentMasterKey}). Returns the counts and the current
 * master key id (a hash prefix, never key material).
 */
export async function rewrapMasterKeys(
  config: KernelConfig,
  opts: { logger: KernelLogger; batchSize?: number },
): Promise<RewrapResult & { currentMasterKeyId: string }> {
  const app = await openKernelCli(config, { logger: opts.logger, modules: [], redis: false });
  try {
    const keyring = app.get<Keyring>(KEYRING);
    const result = await rewrapToCurrentMasterKey(
      { db: app.get(KernelDb), txHost: app.get(TransactionHost) },
      keyring,
      opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {},
    );
    return { ...result, currentMasterKeyId: keyring.currentId };
  } finally {
    await app.close().catch((err: unknown) => {
      opts.logger.debug("secrets rewrap: closing the CLI context failed", { err });
    });
  }
}
