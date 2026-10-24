import type { ModelInfo, ModelParameter, ParamValue, ProviderModels } from "./agents";
import { ApiClientError, apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/**
 * 模型、价格与用途映射（内核 `admin/admin.controller.ts` 与 `models/purposes.controller.ts`）：
 * - 后台（企业管理员）：`GET /admin/models`（供应商带状态 + 价格表 + 币种）、`PUT /admin/model-prices`、
 *   `GET/PUT /admin/model-purposes[/:purpose]`（部署默认）；
 * - 组织（组织管理员，`org.models.manage`）：`GET/PUT /orgs/:orgId/model-purposes[/:purpose]`（组织覆盖）。
 * 价格为每百万 token 的单价，币种为部署设置 `priceCurrency`；成本按价格估算（C2）。
 */

/** 模型能力（对应 plugin-sdk `ModelInfo.capabilities`）。 */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  caching: boolean;
  midConversationSystem?: boolean;
  documents?: boolean;
}

export interface AdminModelInfo extends ModelInfo {
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
}

/** 后台的一个供应商：供应商名即插件名；列模型失败时 `status: "error"`、`models` 为空，不影响其他供应商。 */
export interface AdminProvider {
  provider: string;
  plugin: string;
  status: "ok" | "error";
  /** 内核给的英文说明（不含上游错误原文）。 */
  error?: string;
  models: AdminModelInfo[];
}

/** 一个模型的价格（每百万 token）；缓存读 / 写价为 null 时按输入价计。 */
export interface ModelPrice {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

export interface PriceTable {
  prices: ModelPrice[];
  currency: string;
}

export interface AdminModels extends PriceTable {
  providers: AdminProvider[];
}

/** 一个用途映射到的模型与参数。 */
export interface PurposeTarget {
  model: ModelRef;
  params: Record<string, ParamValue>;
}

/** 用途视图：部署级接口的 `override` 一律为 null。 */
export interface PurposeView {
  purpose: string;
  kind: "chat" | "embedding";
  label: { zh: string; en: string };
  /** `kernel` 或声明它的插件名。 */
  declaredBy: string;
  default: PurposeTarget | null;
  override: PurposeTarget | null;
  effective: PurposeTarget | null;
}

/** 内核用途：评测评委（C9）。未映射时评测不能开评委。 */
export const EVAL_PURPOSE = "eval";

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
const enc = encodeURIComponent;

export const getAdminModels = () => apiFetch<AdminModels>("/api/v1/admin/models");

/** 设一个模型的价格，或 `{provider, model, price: null}` 删除；返回更新后的价格表。 */
export const putModelPrice = (
  body: ModelPrice | { provider: string; model: string; price: null },
) => apiFetch<PriceTable>("/api/v1/admin/model-prices", json("PUT", body));

export const listAdminPurposes = () =>
  apiFetch<{ purposes: PurposeView[] }>("/api/v1/admin/model-purposes");

export const putAdminPurpose = (purpose: string, target: PurposeTarget | null) =>
  apiFetch<{ purpose: PurposeView }>(
    `/api/v1/admin/model-purposes/${enc(purpose)}`,
    json("PUT", { target }),
  );

export const listOrgPurposes = (orgId: string) =>
  apiFetch<{ purposes: PurposeView[] }>(`/api/v1/orgs/${enc(orgId)}/model-purposes`);

export const putOrgPurpose = (orgId: string, purpose: string, target: PurposeTarget | null) =>
  apiFetch<{ purpose: PurposeView }>(
    `/api/v1/orgs/${enc(orgId)}/model-purposes/${enc(purpose)}`,
    json("PUT", { target }),
  );

/** 价格表里查一个模型的价格。 */
export const findPrice = (prices: ModelPrice[], provider: string, model: string) =>
  prices.find((p) => p.provider === provider && p.model === model);

/** 单价上限，与内核 `MODEL_PRICE_PUT` 一致。 */
export const MAX_PER_MTOK = 1_000_000;

/** 单价输入框的文本 → 值：空白为 null；不是数字或不在 0..1e6 为 "invalid"。 */
export function parsePrice(text: string): number | null | "invalid" {
  const s = text.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PER_MTOK ? n : "invalid";
}

/** 下拉框的值：`provider/model`（供应商插件名不含 `/`，模型 id 可能含）。 */
export const encodeModel = (r: ModelRef) => `${r.provider}/${r.model}`;
export function decodeModel(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** 映射目标的显示名：`供应商 / 模型显示名`；模型不在列表里时用模型 id。 */
export function targetName(providers: ProviderModels[], r: ModelRef): string {
  const m = providers.find((p) => p.provider === r.provider)?.models.find((x) => x.id === r.model);
  return `${r.provider} / ${m?.displayName ?? r.model}`;
}

/**
 * 内核 `validation_failed` 的明细 → 用途编辑器的错误：`target.model` 归模型，`target.params.<key>` 归对应参数
 * （声明里没有的键与其他路径进 `other`）。不是校验错误时返回 null。
 */
export function targetIssues(
  e: unknown,
  decl: ModelParameter[],
): { model: boolean; params: string[]; unknownParams: string[]; other: string[] } | null {
  if (!(e instanceof ApiClientError) || e.code !== "validation_failed") return null;
  const out = {
    model: false,
    params: [] as string[],
    unknownParams: [] as string[],
    other: [] as string[],
  };
  for (const d of e.details) {
    if (d.path === "target.model" || d.path.startsWith("target.model.")) out.model = true;
    else if (d.path.startsWith("target.params.")) {
      const key = d.path.slice("target.params.".length);
      if (decl.some((p) => p.key === key)) out.params.push(key);
      else out.unknownParams.push(key);
    } else out.other.push(d.path === "" ? d.message : `${d.path}: ${d.message}`);
  }
  return out;
}
