import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
import type { StorageService } from "./storage.service.js";

/** 维护任务：清理已删除组织的对象存储（任务名与 scheduler id 不含 `:`）。 */
export const STORAGE_PURGE_JOB = "storage-org-purge";
export const STORAGE_PURGE_SCHEDULER_ID = "storage-org-purge-hourly";
export const STORAGE_PURGE_EVERY_MS = 3_600_000;
/** 每次运行最多处理的组织数（成功与失败合计）。 */
const PURGE_BATCH = 100;
/** 认领超过这么久仍未完成（运行中途退出）就可被重新认领。 */
const CLAIM_STALE_MINUTES = 60;

/**
 * 删除「软删除超过 `afterDays` 天、尚未清理存储」的组织的全部对象（`StorageService.deleteOrg`），
 * 成功后写 `orgs.storage_purged_at`，之后不再处理。返回本次清理的组织数。
 * 没有对象存储提供方时什么也不做（不认领、不标记，装上提供方后再清理）。
 *
 * 每个组织三步，不在事务里做网络调用：
 * 1. 认领：一条 `UPDATE … RETURNING`（子查询 `FOR UPDATE SKIP LOCKED`）写 `storage_purge_claimed_at`，
 *    只认领未被认领、或认领已超过 {@link CLAIM_STALE_MINUTES} 分钟的组织。多副本并发运行时同一组织只有一方认领到；
 * 2. 在事务外删除对象（`deleteOrg` 幂等）；
 * 3. 成功：写 `storage_purged_at` 并清空认领；失败：清空认领（下一次运行重试），本次运行不再碰它。
 */
export async function purgeDeletedOrgStorage(d: {
  db: KernelDb;
  storage: StorageService;
  afterDays: number;
  log: Pick<Logger, "info" | "warn">;
}): Promise<number> {
  if (!d.storage.available) return 0;
  let purged = 0;
  const failed: string[] = [];
  while (purged + failed.length < PURGE_BATCH) {
    const claimed = await d.db
      .updateTable("orgs")
      .set({ storage_purge_claimed_at: sql<Date>`now()` })
      .where(
        "id",
        "=",
        d.db
          .selectFrom("orgs")
          .select("id")
          .where("deleted_at", "is not", null)
          .where("storage_purged_at", "is", null)
          .where("deleted_at", "<", sql<Date>`now() - make_interval(days => ${d.afterDays})`)
          .where((eb) =>
            eb.or([
              eb("storage_purge_claimed_at", "is", null),
              eb(
                "storage_purge_claimed_at",
                "<",
                sql<Date>`now() - make_interval(mins => ${CLAIM_STALE_MINUTES})`,
              ),
            ]),
          )
          .$if(failed.length > 0, (q) => q.where("id", "not in", failed))
          .orderBy("deleted_at")
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returning("id")
      .executeTakeFirst();
    if (!claimed) return purged;
    const orgId = claimed.id;
    try {
      const objects = await d.storage.deleteOrg(orgId);
      await d.db
        .updateTable("orgs")
        .set({ storage_purged_at: sql<Date>`now()`, storage_purge_claimed_at: null })
        .where("id", "=", orgId)
        .execute();
      purged++;
      d.log.info("deleted organization storage purged", { orgId, objects });
    } catch (err) {
      failed.push(orgId);
      d.log.warn("cannot purge deleted organization storage; will retry", { orgId, err });
      await d.db
        .updateTable("orgs")
        .set({ storage_purge_claimed_at: null })
        .where("id", "=", orgId)
        .execute()
        .catch((e: unknown) => d.log.warn("cannot release storage purge claim", { orgId, err: e }));
    }
  }
  return purged;
}
