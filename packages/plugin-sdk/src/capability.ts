/** 能力引用，形如 `channel@1`（名称@主版本）。 */
export type CapabilityRef = `${string}@${number}`;

/** 能力基数：single 同时只能有一个提供者，multi 可有多个。 */
export type Cardinality = "single" | "multi";

/** 能力登记信息。 */
export interface CapabilityInfo {
  cardinality: Cardinality;
  /** 经平台能力层代理使用（插件不得 requires，只能经 ctx 平台能力取用）。 */
  brokered: boolean;
  /** 按组织启用（取用时可传 orgId 校验该组织已启用）。 */
  orgScoped: boolean;
}

const info = (cardinality: Cardinality, brokered = false, orgScoped = false): CapabilityInfo => ({
  cardinality,
  brokered,
  orgScoped,
});

/** 已登记的能力。 */
export const CAPABILITIES: Record<string, CapabilityInfo> = {
  sandbox: info("single", true),
  "config-source": info("single"),
  "secret-store": info("single", true),
  "object-store": info("single", true), // 预留（M5）
  channel: info("multi", false, true),
  "model-provider": info("multi", true),
  "identity-source": info("multi"),
  directory: info("multi", false, true),
  counter: info("multi"),
  connector: info("multi", true),
};

/** 已登记能力的基数（由 CAPABILITIES 派生的兼容导出）。 */
export const CAPABILITY_CARDINALITY: Record<string, Cardinality> = Object.fromEntries(
  Object.entries(CAPABILITIES).map(([k, v]) => [k, v.cardinality]),
);

/** 连接器能力引用（见 `connector.ts`）。 */
export const CONNECTOR_CAPABILITY = "connector@1";

/** IM 渠道能力引用（见 `channel.ts`）。 */
export const CHANNEL_CAPABILITY = "channel@1";

/** 外部登录身份来源能力引用（见 `identity.ts`）。 */
export const IDENTITY_SOURCE_CAPABILITY = "identity-source@1";

/** 通讯录能力引用（见 `directory.ts`）。 */
export const DIRECTORY_CAPABILITY = "directory@1";

/** 解析能力引用；格式不合法时抛错。 */
export function parseCapability(ref: string): { name: string; major: number } {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`invalid capability ref "${ref}", expected "<name>@<major>"`);
  return { name: m[1] as string, major: Number(m[2]) };
}
