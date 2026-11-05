import {
  type ConfigUiHints,
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { createFakeProvider } from "./script.js";

/**
 * Form labels (zod meta `ui`, extension config forms spec §3). Written as plain meta rather than
 * the SDK's `ui()` so the bundle imports nothing an older host SDK lacks.
 */
const label = (zh: string, en: string): { ui: ConfigUiHints } => ({ ui: { label: { zh, en } } });

/** Deployment config: the available models (default: one, fake-1). */
const DeploymentConfig = z.object({
  models: z
    .array(
      z.object({
        id: z.string().min(1).meta(label("模型 ID", "Model ID")),
        contextWindow: z
          .number()
          .int()
          .positive()
          .optional()
          .meta(label("上下文窗口", "Context window")),
        streamIdleTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .meta(label("流空闲超时（毫秒）", "Stream idle timeout (ms)")),
        /** Declares image / document input support (default false). */
        vision: z.boolean().optional().meta(label("图片输入", "Image input")),
        documents: z.boolean().optional().meta(label("文档输入", "Document input")),
      }),
    )
    .optional()
    .meta(label("模型", "Models")),
});

/**
 * 确定性脚本化模型供应商，用于运行时测试、e2e 与无密钥演示。
 * 行为由最后一条 user 消息的英文前缀指令决定（echo / media / slow / slowfail / stall / fail / tool / long）。
 * 提供 model-provider@2：声明三档 effort 与 `model-fake.style`（`shout` 时回复转大写）。
 * 无进程内状态：缓存命中记录放 ctx.kv（TTL 300 秒）。
 */
export default defineExtension({
  name: "model-fake",
  version: "0.1.0-rc.2",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { models } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createFakeProvider({ kv: ctx.kv, ...(models !== undefined ? { models } : {}) }),
    );
  },
});
