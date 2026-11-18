import {
  type ConfigUiHints,
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  orgAccess,
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
  models: orgAccess(
    z
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
          kind: z
            .enum([
              "chat",
              "embedding",
              "rerank",
              "image_generation",
              "video_generation",
              "speech_to_text",
              "text_to_speech",
            ])
            .optional()
            .meta(label("类型", "Kind")),
          publisher: z.string().optional().meta(label("发布者", "Publisher")),
          dimensions: z
            .array(z.number().int().positive())
            .optional()
            .meta(label("向量维度", "Embedding dimensions")),
          maxBatch: z
            .number()
            .int()
            .positive()
            .optional()
            .meta(label("单次最大输入数", "Max inputs per call")),
          maxImages: z
            .number()
            .int()
            .positive()
            .optional()
            .meta(label("单次最大出图数", "Max images per call")),
          maxReferenceImages: z
            .number()
            .int()
            .min(0)
            .optional()
            .meta(label("最大参考图数", "Max reference images")),
        }),
      )
      .optional()
      .meta(label("模型", "Models")),
    "override",
  ),
});

/**
 * A deterministic scripted model provider for runtime tests, e2e and keyless demos.
 * The last user message's English prefix command decides the behavior (echo / media / slow /
 * slowfail / stall / fail / tool / slowtool / long).
 * Image generation models (kind image_generation) follow the prompt's first word: refuse (a
 * refusal) / stall (waits for the abort) / fail <kind> / short (one image too few) / url (returns
 * a URL); otherwise n 1×1 PNGs.
 * Provides model-provider@2: declares three effort levels and `model-fake.style` (`shout` upper-
 * cases the reply).
 * No in-process state: cache hit records live in ctx.kv (TTL 300 seconds).
 */
export default defineExtension({
  name: "model-fake",
  version: "0.1.0-rc.34",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    const { models } = DeploymentConfig.parse(ctx.config ?? {});
    ctx.provide(
      MODEL_PROVIDER_EXTENSION_POINT_V2,
      createFakeProvider({
        kv: ctx.kv,
        ...(models !== undefined ? { models } : {}),
        modelsOf: (config) => {
          const parsed = DeploymentConfig.safeParse(config ?? {});
          if (!parsed.success) {
            throw new ModelError(
              "invalid_request",
              `Invalid model-fake config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            );
          }
          return parsed.data.models;
        },
      }),
    );
  },
});
