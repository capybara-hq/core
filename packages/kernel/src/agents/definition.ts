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
 * agent 定义里对工具的引用：内置工具按名字；插件工具按插件名 + 工具名；应用工具按应用 id，
 * `tools: "all"` = 该应用当前所有启用的工具。
 */
export const AgentToolRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), name: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("plugin"), plugin: z.string().min(1), name: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("app"),
      appId: z.string().min(1),
      tools: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
    })
    .strict(),
]);
export type AgentToolRef = z.infer<typeof AgentToolRef>;

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
   */
  skills: z
    .object({ orgSkills: z.array(z.string().min(1).max(100)).max(100).default([]) })
    .strict()
    .optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
