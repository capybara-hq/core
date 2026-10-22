import { z } from "zod";

/** 模型引用：供应商插件名 + 模型 id。 */
export const ModelRef = z.object({ provider: z.string(), model: z.string() });
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * 模型参数（键为插件声明的参数键）：只接受标量；按该模型的 `parameters` 声明校验在 `AgentsService`
 * 中进行（保存时严格，运行时宽松，见 plugin-sdk `validateParams` / `sanitizeParams`）。
 */
export const ModelParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type ModelParams = z.infer<typeof ModelParams>;

/**
 * 改名前（D17）保存的连接器引用 `{ kind: "app", appId, tools }` 规范化为 `{ kind: "connector", connectorId, tools }`
 * （C27：已存 agent 版本不改写，读入时规范化；新保存只写 connector 形）。其余值原样返回。
 */
export function normalizeToolRef(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const r = v as Record<string, unknown>;
  if (r.kind !== "app") return v;
  const { kind: _kind, appId, ...rest } = r;
  return { kind: "connector", connectorId: appId, ...rest };
}

/**
 * agent 定义里对工具的引用：内置工具按名字；插件工具按插件名 + 工具名；连接器工具按连接器 id，
 * `tools: "all"` = 该连接器当前所有启用的工具。旧形 `{ kind: "app", appId }` 仍可解析（见 {@link normalizeToolRef}）。
 */
export const AgentToolRef = z.preprocess(
  normalizeToolRef,
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("builtin"), name: z.string().min(1) }).strict(),
    z
      .object({ kind: z.literal("plugin"), plugin: z.string().min(1), name: z.string().min(1) })
      .strict(),
    z
      .object({
        kind: z.literal("connector"),
        connectorId: z.string().min(1),
        tools: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
      })
      .strict(),
  ]),
);
export type AgentToolRef = z.output<typeof AgentToolRef>;

/**
 * 新建 agent 未给 `tools` 时的默认工具（`tool_search` 由注册表按组织设置自动加入，不进定义）。
 * 只用于创建请求；修改与读出旧版本都不注入默认值。
 */
export const DEFAULT_AGENT_TOOLS: AgentToolRef[] = [
  { kind: "builtin", name: "ask_user" },
  { kind: "builtin", name: "read_tool_output" },
];

/** Agent 定义：每次变化写一个新版本（`capybara.agent_versions`）。 */
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.url().nullable().default(null),
  instructions: z.string().max(100_000).default(""),
  model: ModelRef,
  fallback: ModelRef.nullable().default(null),
  /** 主模型的参数（按主模型的声明校验）。 */
  modelParams: ModelParams.default({}),
  /** 兜底模型自己的参数（按兜底模型的声明校验）；兜底尝试只用这一份。 */
  fallbackParams: ModelParams.default({}),
  /** 引用的工具（M2 保存的 `tools: []` 仍然合法）；保存时校验引用存在，运行时由注册表解析。 */
  tools: z.array(AgentToolRef).default([]),
  /**
   * 按工具 key 收紧策略（只能收紧：`ask` / `deny`，不接受 `allow`）；键必须是该 agent 引用的工具的 key。
   * 较早保存的定义没有该字段，按空处理。
   */
  toolPolicies: z.record(z.string(), z.enum(["ask", "deny"])).default({}),
  /**
   * 技能（M5 T13）：`orgSkills` 是引用的组织技能 id（保存时校验属于本组织且未删除，不可重复）。
   * agent 自己的技能（`scope=agent`）自动对它生效，不进定义。可省略（较早保存的定义也没有），按空处理；
   * 不给默认值：没用技能的定义保存前后不变，不会因此多出一个版本。
   * `writePolicy`（M6 T27，D10）：私有 agent 的 `skill_write` 是否固定确认，缺省按 `allow`（不写进定义）；
   * 共享 agent 不论取值都走 R3 + R4。
   */
  skills: z
    .object({
      orgSkills: z.array(z.string().min(1).max(100)).max(100).default([]),
      writePolicy: z.enum(["allow", "ask"]).optional(),
    })
    .strict()
    .optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * 库里读出的定义（`agent_versions.definition`，不经 zod 解析）：把改名前的 `{ kind: "app" }` 工具引用规范化为
 * connector 形（C27）。其余字段原样保留；没有旧形引用时返回原对象。
 */
export function normalizeStoredDefinition(def: unknown): AgentDefinition {
  const d = def as AgentDefinition;
  const tools = (d as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || !tools.some((t) => (t as { kind?: unknown })?.kind === "app")) {
    return d;
  }
  return { ...d, tools: tools.map(normalizeToolRef) as AgentToolRef[] };
}
