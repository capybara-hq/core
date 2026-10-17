import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "./enterprise-admin.js";

export const DEPLOYMENT_SETTINGS = z.object({
  orgCreation: z.enum(["anyone", "enterprise_admin"]).default("anyone"),
});
export type DeploymentSettings = z.infer<typeof DEPLOYMENT_SETTINGS>;

const DEFAULTS: DeploymentSettings = DEPLOYMENT_SETTINGS.parse({});

/** 部署级设置：每个键一行，读时缺省用默认值。 */
export class SettingsService {
  constructor(
    private readonly db: KernelDb,
    private readonly log?: Pick<Logger, "warn">,
  ) {}

  /**
   * 读全部设置；传 `trx` 时在该事务内读（调用方已持有事务连接时不再占用池里的第二个连接）。
   * 逐个键校验：库里某个键的值非法时该键用默认值并 warn 点名，其余合法的键照常生效；
   * 不认识的键（如新版本写入的）忽略。
   */
  async get(trx?: Transaction<KernelDatabase>): Promise<DeploymentSettings> {
    const rows = await (trx ?? this.db)
      .selectFrom("deployment_settings")
      .select(["key", "value"])
      .execute();
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));
    const out: Record<string, unknown> = { ...DEFAULTS };
    for (const [key, field] of Object.entries(DEPLOYMENT_SETTINGS.shape)) {
      if (!stored.has(key)) continue;
      const parsed = field.safeParse(stored.get(key));
      if (parsed.success) {
        out[key] = parsed.data;
      } else {
        this.log?.warn("invalid deployment setting; using default", {
          key,
          issues: parsed.error.issues.map((i) => i.message),
        });
      }
    }
    return out as DeploymentSettings;
  }

  /** 更新设置：事务内取企业管理员锁并复核发起人仍是活跃企业管理员（否则 `forbidden`）。 */
  async update(
    patch: Partial<DeploymentSettings>,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<DeploymentSettings> {
    const check = DEPLOYMENT_SETTINGS.partial().safeParse(patch);
    if (!check.success) {
      throw new ApiError(
        "validation_failed",
        "Invalid deployment settings",
        check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actorAccountId);
      for (const [key, value] of Object.entries(check.data)) {
        if (value === undefined) continue;
        const json = JSON.stringify(value);
        await trx
          .insertInto("deployment_settings")
          .values({ key, value: json, updated_by: actorAccountId })
          .onConflict((oc) =>
            oc
              .column("key")
              .doUpdateSet({ value: json, updated_by: actorAccountId, updated_at: new Date() }),
          )
          .execute();
      }
      await audit(trx, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        action: "deployment.settings.updated",
        detail: check.data,
      });
    });
    return this.get();
  }
}
