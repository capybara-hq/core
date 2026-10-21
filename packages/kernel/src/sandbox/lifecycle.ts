import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Maintenance } from "../runtime/maintenance.js";
import type { SandboxService } from "./sandbox.service.js";

/** 空闲休眠扫描：任务名、job scheduler id（不含 `:`）与周期。 */
export const SANDBOX_SUSPEND_JOB = "sandbox-suspend-idle";
export const SANDBOX_SUSPEND_SCHEDULER_ID = "sandbox-suspend-idle-every-minute";
export const SANDBOX_SUSPEND_EVERY_MS = 60_000;

/** 不活跃销毁扫描：任务名、job scheduler id（不含 `:`）与周期。 */
export const SANDBOX_DESTROY_JOB = "sandbox-destroy-inactive";
export const SANDBOX_DESTROY_SCHEDULER_ID = "sandbox-destroy-inactive-hourly";
export const SANDBOX_DESTROY_EVERY_MS = 3_600_000;

/** 一次性任务：立即销毁一批对话的沙箱（成员离职后投递，数据 `{ conversationIds }`）。 */
export const SANDBOX_DESTROY_FOR_JOB = "sandbox-destroy-for";

/** 投递 {@link SANDBOX_DESTROY_FOR_JOB}：失败的整批重试（已销毁的再调一次什么也不做）。 */
export async function scheduleSandboxDestroy(
  maintenance: Pick<Maintenance, "add">,
  conversationIds: string[],
): Promise<void> {
  await maintenance.add(
    SANDBOX_DESTROY_FOR_JOB,
    { conversationIds },
    {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

/**
 * 在维护队列（`cap-kernel-maintenance`）登记沙箱的两个周期任务（worker 角色执行）：
 * 每分钟休眠空闲 / 连续运行超时的沙箱，每小时销毁不活跃、组织已删除或对话已删除的沙箱。
 * 没有沙箱提供方时两个任务什么也不做。另登记一次性任务 {@link SANDBOX_DESTROY_FOR_JOB}（成员离职）。
 */
export function registerSandboxMaintenance(
  maintenance: Maintenance,
  sandbox: SandboxService,
  log: Pick<Logger, "info" | "warn">,
): void {
  maintenance.handle(SANDBOX_DESTROY_FOR_JOB, async (job) => {
    const ids = (job.data as { conversationIds?: unknown }).conversationIds;
    if (!Array.isArray(ids)) return;
    let failed = 0;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      try {
        await sandbox.destroyFor(id);
      } catch (err) {
        failed++;
        log.warn("cannot destroy sandbox of an offboarded member; will retry", {
          conversationId: id,
          err,
        });
      }
    }
    if (failed > 0) throw new Error(`${failed} of ${ids.length} sandboxes could not be destroyed`);
  });
  maintenance.handle(SANDBOX_SUSPEND_JOB, async () => {
    const n = await sandbox.suspendIdle(new Date());
    if (n > 0) log.info("idle sandboxes suspended", { count: n });
  });
  maintenance.schedule({
    id: SANDBOX_SUSPEND_SCHEDULER_ID,
    name: SANDBOX_SUSPEND_JOB,
    everyMs: () => SANDBOX_SUSPEND_EVERY_MS,
  });
  maintenance.handle(SANDBOX_DESTROY_JOB, async () => {
    const n = await sandbox.destroyInactive(new Date());
    if (n > 0) log.info("inactive sandboxes destroyed", { count: n });
  });
  maintenance.schedule({
    id: SANDBOX_DESTROY_SCHEDULER_ID,
    name: SANDBOX_DESTROY_JOB,
    everyMs: () => SANDBOX_DESTROY_EVERY_MS,
  });
}
