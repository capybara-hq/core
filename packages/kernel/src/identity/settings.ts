import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "./enterprise-admin.js";

/** 币种代码：ISO 4217 的三位大写字母（如 USD、CNY）。 */
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code");

export const DEPLOYMENT_SETTINGS = z.object({
  orgCreation: z.enum(["anyone", "enterprise_admin"]).default("anyone"),
  /** 按组织覆盖运行并发上限（orgId → 上限）；未列出的组织用 `runtime.orgConcurrency`。 */
  runConcurrencyOverrides: z.record(z.string().min(1), z.number().int().positive()).default({}),
  /** 模型价格表（`model_prices`）的币种；只用于显示估算成本，不做换算。 */
  priceCurrency: CurrencyCode.default("USD"),
});
export type DeploymentSettings = z.infer<typeof DEPLOYMENT_SETTINGS>;

const DEFAULTS: DeploymentSettings = DEPLOYMENT_SETTINGS.parse({});

/**
 * 设置的修改（PUT /api/v1/admin/settings 的 body）：只改给出的键。
 * `runConcurrencyOverrides` 按组织合并：值为正整数 → 设置该组织的上限；值为 null → 删除该组织的覆盖
 * （回到 `runtime.orgConcurrency`）；未列出的组织保持不变。
 */
export const DEPLOYMENT_SETTINGS_PATCH = z
  .object({
    orgCreation: z.enum(["anyone", "enterprise_admin"]).optional(),
    runConcurrencyOverrides: z
      .record(z.string().min(1), z.number().int().positive().nullable())
      .optional(),
    priceCurrency: CurrencyCode.optional(),
  })
  .strict();
export type DeploymentSettingsPatch = z.infer<typeof DEPLOYMENT_SETTINGS_PATCH>;

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
    patch: DeploymentSettingsPatch,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<DeploymentSettings> {
    const check = DEPLOYMENT_SETTINGS_PATCH.safeParse(patch);
    if (!check.success) {
      throw new ApiError(
        "validation_failed",
        "Invalid deployment settings",
        check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actorAccountId);
      // 企业管理员锁串行化所有设置修改：在锁内读当前覆盖再合并，不会丢失并发修改。
      const next: Partial<DeploymentSettings> = {};
      if (check.data.orgCreation !== undefined) next.orgCreation = check.data.orgCreation;
      if (check.data.priceCurrency !== undefined) next.priceCurrency = check.data.priceCurrency;
      if (check.data.runConcurrencyOverrides !== undefined) {
        const merged = { ...(await this.get(trx)).runConcurrencyOverrides };
        for (const [orgId, limit] of Object.entries(check.data.runConcurrencyOverrides)) {
          if (limit === null) delete merged[orgId];
          else merged[orgId] = limit;
        }
        next.runConcurrencyOverrides = merged;
      }
      for (const [key, value] of Object.entries(next)) {
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
