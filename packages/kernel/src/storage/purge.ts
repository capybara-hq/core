import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
import type { StorageService } from "./storage.service.js";

/** 维护任务：清理已删除组织的对象存储（任务名与 scheduler id 不含 `:`）。 */
export const STORAGE_PURGE_JOB = "storage-org-purge";
export const STORAGE_PURGE_SCHEDULER_ID = "storage-org-purge-hourly";
export const STORAGE_PURGE_EVERY_MS = 3_600_000;
/** 每批处理的组织数。 */
const PURGE_BATCH = 100;

/**
 * 删除「软删除超过 `afterDays` 天、尚未清理存储」的组织的全部对象（`StorageService.deleteOrg`），
 * 成功后写 `orgs.storage_purged_at`，之后不再处理。返回本次清理的组织数。
 * 没有对象存储提供方时什么也不做（不标记，装上提供方后再清理）。
 * 多副本同时执行时：每个组织先在事务里 `FOR UPDATE SKIP LOCKED` 锁行再删，互不重复；
 * `deleteOrg` 幂等，中途失败的组织下次重试。
 */
export async function purgeDeletedOrgStorage(d: {
  db: KernelDb;
  storage: StorageService;
  afterDays: number;
  log: Pick<Logger, "info" | "warn">;
}): Promise<number> {
  if (!d.storage.available) return 0;
  let purged = 0;
  const failed = new Set<string>();
  for (;;) {
    const done = await d.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("orgs")
        .select("id")
        .where("deleted_at", "is not", null)
        .where("storage_purged_at", "is", null)
        .where("deleted_at", "<", sql<Date>`now() - make_interval(days => ${d.afterDays})`)
        .$if(failed.size > 0, (q) => q.where("id", "not in", [...failed]))
        .orderBy("deleted_at")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return "none" as const;
      try {
        const objects = await d.storage.deleteOrg(row.id);
        await trx
          .updateTable("orgs")
          .set({ storage_purged_at: sql<Date>`now()` })
          .where("id", "=", row.id)
          .execute();
        d.log.info("deleted organization storage purged", { orgId: row.id, objects });
        return "purged" as const;
      } catch (err) {
        d.log.warn("cannot purge deleted organization storage", { orgId: row.id, err });
        failed.add(row.id);
        return "failed" as const;
      }
    });
    if (done === "none") return purged;
    if (done === "purged") purged++;
    if (purged + failed.size >= PURGE_BATCH) return purged;
  }
}
