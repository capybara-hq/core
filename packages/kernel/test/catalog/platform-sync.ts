import type { INestApplicationContext } from "@nestjs/common";
import {
  PlatformComponents,
  type PlatformSyncResult,
} from "../../src/catalog/platform-components.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";

/**
 * Writes the platform components of stored catalog version `version` of item `itemId` as the
 * kernel's own callers do: planned and their files copied before a transaction
 * (`prepareSync`), the rows written in it (`applySyncIn`). For tests that seed items without an
 * import, and for a sync of a later version without the platform update's checks.
 */
export async function syncPlatformComponents(
  app: INestApplicationContext,
  itemId: string,
  version: string,
): Promise<PlatformSyncResult> {
  const platform = app.get(PlatformComponents);
  const prepared = await platform.prepareSync(itemId, version);
  return app.get(TransactionHost).run(() => platform.applySyncIn(prepared));
}
