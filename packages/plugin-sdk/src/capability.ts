/** 能力引用，形如 `channel@1`（名称@主版本）。 */
export type CapabilityRef = `${string}@${number}`;

/** 能力基数：single 同时只能有一个提供者，multi 可有多个。 */
export type Cardinality = "single" | "multi";

/** 已登记的能力及其基数。 */
export const CAPABILITY_CARDINALITY: Record<string, Cardinality> = {
  sandbox: "single",
  "config-source": "single",
  "secret-store": "single",
  channel: "multi",
  "model-provider": "multi",
  "identity-source": "multi",
  directory: "multi",
  counter: "multi",
  connector: "multi",
};

/** 连接器能力引用（见 `connector.ts`）。 */
export const CONNECTOR_CAPABILITY = "connector@1";

/** 解析能力引用；格式不合法时抛错。 */
export function parseCapability(ref: string): { name: string; major: number } {
  const m = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`invalid capability ref "${ref}", expected "<name>@<major>"`);
  return { name: m[1] as string, major: Number(m[2]) };
}
