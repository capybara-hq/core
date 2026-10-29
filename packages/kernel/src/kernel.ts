import { fileURLToPath } from "node:url";
import type { KernelConfig } from "./config/schema.js";
import { migrate } from "./db/migrator.js";
import type { PendingExtension } from "./extensions/approvals.js";
import { ExtensionHost } from "./extensions/host.js";

/**
 * The kernel migrations directory. `src/` and `dist/` are both one level below the package root,
 * so this always points at `<package root>/src/migrations`: running from source with tsx and
 * running the tsc output resolve to the same directory (the SQL files are not copied into dist;
 * the package ships `src/migrations`).
 */
export const KERNEL_MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** The kernel's PG schema. */
export const KERNEL_SCHEMA = "capybara";

/**
 * Runs the kernel migrations and those of every configured extension (no extension `setup`, no
 * Redis connection). Extensions whose permissions await approval are not migrated (unless
 * `extensionPermissions.autoApprove`); they are reported through `opts.onPending`.
 */
export async function migrateAll(
  config: KernelConfig,
  opts: {
    resolveFrom?: string;
    onPending?: (pending: PendingExtension[]) => void;
  } = {},
): Promise<{ schema: string; plugin?: string; applied: string[] }[]> {
  const connectTimeoutMs = config.db.connectTimeoutMs;
  const kernel = await migrate(
    config.db.url,
    { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
    { connectTimeoutMs },
  );
  const plugins = await ExtensionHost.migrateOnly(config.extensions, {
    dbUrl: config.db.url,
    connectTimeoutMs,
    autoApprove: config.extensionPermissions.autoApprove,
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    ...(opts.onPending !== undefined && { onPending: opts.onPending }),
  });
  return [{ schema: KERNEL_SCHEMA, applied: kernel.applied }, ...plugins];
}
