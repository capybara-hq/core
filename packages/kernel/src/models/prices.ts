import type { ModelUsage } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { legacyCurrentTrx } from "../infra/database/legacy-view.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";

/**
 * 一个模型的价格（C2）：每百万 token，币种为部署设置 `priceCurrency`。由企业管理员录入，插件不声明价格。
 * 缓存读 / 写价为 null 时按输入价计。
 */
export interface ModelPrice {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

/** 价格表：键为 {@link priceKey}（`${provider}\n${model}`）。 */
export type PriceTable = ReadonlyMap<string, ModelPrice>;

/** 价格表的键。供应商名与模型 id 不含换行，拼接不会撞键。 */
export const priceKey = (provider: string, model: string): string => `${provider}\n${model}`;

/** 一次调用的估算成本；没有价格 → null。用量的四项互不重叠（见 plugin-sdk `ModelUsage`）。 */
export function costOf(usage: ModelUsage, price: ModelPrice | undefined): number | null {
  if (price === undefined) return null;
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok;
  return (
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000
  );
}

/** 单价：≥ 0 且 ≤ 1e6（有限数）。 */
const PerMTok = z.number().min(0).max(1_000_000);
const Name = z.string().min(1).max(200);

/** `PUT /api/v1/admin/model-prices` 的 body：设一个价格，或 `price: null` 删除。 */
export const MODEL_PRICE_PUT = z.union([
  z
    .object({
      provider: Name,
      model: Name,
      inputPerMTok: PerMTok,
      outputPerMTok: PerMTok,
      cacheReadPerMTok: PerMTok.nullable(),
      cacheWritePerMTok: PerMTok.nullable(),
    })
    .strict(),
  z.object({ provider: Name, model: Name, price: z.null() }).strict(),
]);
export type ModelPricePut = z.infer<typeof MODEL_PRICE_PUT>;

const num = (v: string): number => Number(v);
const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

/** 模型价格（PG `model_prices`）：每次读都查库，不在进程内缓存（多副本下改价立刻生效）。 */
@Injectable()
export class PricesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** 全部价格，按 provider、model 排序。 */
  async list(): Promise<ModelPrice[]> {
    const rows = await this.db
      .selectFrom("model_prices")
      .select([
        "provider",
        "model",
        "input_per_mtok",
        "output_per_mtok",
        "cache_read_per_mtok",
        "cache_write_per_mtok",
      ])
      .orderBy("provider")
      .orderBy("model")
      .execute();
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputPerMTok: num(r.input_per_mtok),
      outputPerMTok: num(r.output_per_mtok),
      cacheReadPerMTok: numOrNull(r.cache_read_per_mtok),
      cacheWritePerMTok: numOrNull(r.cache_write_per_mtok),
    }));
  }

  /** 价格表（按 {@link priceKey} 查）。 */
  async table(): Promise<PriceTable> {
    return new Map((await this.list()).map((p) => [priceKey(p.provider, p.model), p]));
  }

  /**
   * 设置或删除（`price: null`）一个模型的价格：事务内取企业管理员锁并复核发起人仍是活跃企业管理员
   * （否则 `forbidden`），写审计 `model_price.updated` / `model_price.deleted`。
   */
  async put(
    input: ModelPrice | { provider: string; model: string; price: null },
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    const check = MODEL_PRICE_PUT.safeParse(input);
    if (!check.success) {
      throw new ApiError(
        "validation_failed",
        "Invalid model price",
        check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    await this.write(check.data, actorAccountId, actorTokenId);
  }

  /** The write of {@link put}, under the enterprise admin lock. */
  @Transactional()
  private async write(
    v: ModelPricePut,
    actorAccountId: string,
    actorTokenId: string | undefined,
  ): Promise<void> {
    await lockEnterpriseAdminsAndAuthorize(legacyCurrentTrx(), actorAccountId);
    const target = `${v.provider}/${v.model}`;
    if ("price" in v) {
      await this.db
        .deleteFrom("model_prices")
        .where("provider", "=", v.provider)
        .where("model", "=", v.model)
        .execute();
      await audit(this.db.db, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        action: "model_price.deleted",
        target,
        detail: { provider: v.provider, model: v.model },
      });
      return;
    }
    const values = {
      input_per_mtok: v.inputPerMTok,
      output_per_mtok: v.outputPerMTok,
      cache_read_per_mtok: v.cacheReadPerMTok,
      cache_write_per_mtok: v.cacheWritePerMTok,
      updated_by: actorAccountId,
    };
    await this.db
      .insertInto("model_prices")
      .values({ provider: v.provider, model: v.model, ...values })
      .onConflict((oc) =>
        oc.columns(["provider", "model"]).doUpdateSet({ ...values, updated_at: new Date() }),
      )
      .execute();
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      action: "model_price.updated",
      target,
      detail: { ...v },
    });
  }
}
