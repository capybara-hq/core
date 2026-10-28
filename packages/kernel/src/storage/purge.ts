import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type PrefixedStorage, StorageService } from "./storage.service.js";

/** 定时任务：清理已删除组织的对象存储（名字不含 `:`），每小时整点。 */
export const STORAGE_PURGE_JOB = "storage-org-purge";
/** The maintenance job scheduler id it had before it became a cron (retired at worker start). */
export const STORAGE_PURGE_SCHEDULER_ID = "storage-org-purge-hourly";
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
 *    只认领未被认领、或认领已超过 {@link CLAIM_STALE_MINUTES} 分钟的组织。同一时刻的并发认领只有一方成功；
 *    但认领不是租约：持有方删得比 {@link CLAIM_STALE_MINUTES} 还久（或已退出）时，别的副本会重新认领，两方可能
 *    同时删同一组织的对象，先结束的一方还会清掉对方的认领。这是可以接受的：`deleteOrg` 幂等，`storage_purged_at`
 *    只在删除成功后写，最坏只是重复删除或下一轮再删一次；
 * 2. 在事务外删除对象（`deleteOrg` 幂等）；
 * 3. 成功：写 `storage_purged_at` 并清空认领；失败：清空认领（下一次运行重试），本次运行不再碰它。
 */
export async function purgeDeletedOrgStorage(d: {
  db: Pick<KernelSchemaDb, "updateTable" | "selectFrom">;
  storage: PrefixedStorage;
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

/**
 * The hourly `storage-org-purge` job (fixed period: `@LockedCron`, once per tick across replicas):
 * {@link purgeDeletedOrgStorage} with `storage.purgeDeletedOrgsAfterDays`.
 */
@Injectable()
export class StoragePurgeJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("0 * * * *", { name: STORAGE_PURGE_JOB })
  async run(): Promise<void> {
    await purgeDeletedOrgStorage({
      db: this.db,
      storage: this.storage,
      afterDays: this.config.get().storage.purgeDeletedOrgsAfterDays,
      log: this.log,
    });
  }
}
