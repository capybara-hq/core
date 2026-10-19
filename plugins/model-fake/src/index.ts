import { definePlugin, MODEL_PROVIDER_CAPABILITY_V2 } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createFakeProvider } from "./script.js";

/** 部署级配置：可用模型列表，默认一个 fake-1。 */
const DeploymentConfig = z.object({
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        contextWindow: z.number().int().positive().optional(),
        streamIdleTimeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

/**
 * 确定性脚本化模型供应商，用于运行时测试、e2e 与无密钥演示。
 * 行为由最后一条 user 消息的英文前缀指令决定（echo / slow / slowfail / stall / fail / tool / long）。
 * 提供 model-provider@2：声明三档 effort 与 `model-fake.style`（`shout` 时回复转大写）。
 * 无进程内状态：缓存命中记录放 ctx.kv（TTL 300 秒）。
 */
export default definePlugin({
  name: "model-fake",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { models } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_CAPABILITY_V2,
      createFakeProvider({ kv: ctx.kv, ...(models !== undefined ? { models } : {}) }),
    );
  },
});
