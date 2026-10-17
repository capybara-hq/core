import type { Effort } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 模型引用：供应商插件名 + 模型 id。 */
export const ModelRef = z.object({ provider: z.string(), model: z.string() });
export type ModelRef = z.infer<typeof ModelRef>;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];

/** Agent 定义：每次变化写一个新版本（`capybara.agent_versions`）。 */
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.url().nullable().default(null),
  instructions: z.string().max(100_000).default(""),
  model: ModelRef,
  fallback: ModelRef.nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
  /** M3 才支持工具；现在只接受空数组。 */
  tools: z.array(z.never()).default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
