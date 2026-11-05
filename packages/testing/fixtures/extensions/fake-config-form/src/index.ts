import {
  type ConfigUiHints,
  defineExtension,
  type LocalizedName,
  secret,
  ui,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of a hinted deployment config (extension config forms spec §6): the shape of
 * openai-compatible's config (endpoints with models, API keys in a top-level secret record keyed by
 * endpoint name) with the hints that plugin carries, so the web form (presets, item secrets, model
 * rows, advanced fields, localized custom issues) is tested without an official plugin. It provides
 * nothing and calls no service: setup only validates the config. Display name 表单样例 / Form sample.
 */

const T = (zh: string, en: string): LocalizedName => ({ zh, en });
const flag = (zh: string, en: string, help?: LocalizedName) =>
  ui(z.boolean().optional(), { label: T(zh, en), widget: "checkbox", ...(help && { help }) });

/** Whether a dialect accepts PDF documents (as in openai-compatible: generic and qwen). */
const acceptsPdf = (dialect: string): boolean => dialect === "generic" || dialect === "qwen";

const EndpointModelSchema = ui(
  z.object({
    id: ui(z.string().min(1), { label: T("模型 ID", "Model ID"), placeholder: "deepseek-chat" }),
    contextWindow: ui(z.number().int().positive(), {
      label: T("上下文窗口", "Context window"),
      unit: T("tokens", "tokens"),
    }),
    maxOutputTokens: ui(z.number().int().positive(), {
      label: T("最大输出", "Max output"),
      unit: T("tokens", "tokens"),
    }),
    vision: flag("图片", "Images"),
    documents: flag(
      "PDF 文档",
      "PDF documents",
      T("仅通用与通义千问方言支持", "Only the generic and Qwen dialects accept PDF"),
    ),
    reasoning: flag("推理", "Reasoning"),
    caching: ui(z.boolean().optional(), {
      label: T("缓存", "Caching"),
      widget: "tristate",
      help: T("默认按方言", "Default follows the dialect"),
      advanced: true,
    }),
    streamIdleTimeoutMs: ui(z.number().int().positive().optional(), {
      label: T("流空闲超时", "Stream idle timeout"),
      unit: T("毫秒", "ms"),
      advanced: true,
    }),
  }),
  { layout: "row" },
);

const EndpointSchema = z.strictObject({
  name: ui(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), {
    label: T("名称", "Name"),
    help: T("对外模型 ID 为 <名称>/<模型 ID>", "Models are exposed as <name>/<model id>"),
  }),
  baseUrl: ui(z.string().url(), {
    label: T("接口地址", "Base URL"),
    widget: "url",
    placeholder: "https://api.example.com/v1",
  }),
  dialect: ui(z.enum(["generic", "deepseek", "qwen", "ark"]), {
    label: T("方言", "Dialect"),
    options: [
      { value: "generic", label: T("通用（vLLM 等）", "Generic (vLLM, …)") },
      { value: "deepseek", label: T("DeepSeek", "DeepSeek") },
      { value: "qwen", label: T("通义千问（百炼）", "Qwen (Model Studio)") },
      { value: "ark", label: T("火山方舟", "Volcano Ark") },
    ],
  }),
  midConversationSystem: ui(z.boolean().optional(), {
    label: T("对话中途的 system 消息", "Mid-conversation system messages"),
    widget: "tristate",
    advanced: true,
  }),
  models: ui(
    z
      .array(EndpointModelSchema)
      .min(1)
      .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, {
        params: { ui: "duplicateModel" },
      }),
    {
      label: T("模型", "Models"),
      item: { title: "{id}", addLabel: T("添加模型", "Add model"), reorder: true },
    },
  ),
});

const ENDPOINTS: ConfigUiHints = {
  label: T("端点", "Endpoints"),
  item: {
    title: "{name}",
    subtitle: "{baseUrl}",
    addLabel: T("添加端点", "Add endpoint"),
    reorder: true,
  },
  secrets: [
    {
      path: "apiKeys",
      keyBy: "name",
      after: "baseUrl",
      label: T("API 密钥", "API key"),
      help: T(
        "留空则请求不带凭据（如内网 vLLM）",
        "Leave empty for services without a key (e.g. an internal vLLM)",
      ),
    },
  ],
  presets: [
    {
      id: "deepseek",
      label: T("DeepSeek", "DeepSeek"),
      values: { name: "deepseek", baseUrl: "https://api.deepseek.com", dialect: "deepseek" },
    },
    {
      id: "qwen",
      label: T("通义千问（百炼）", "Qwen (Model Studio)"),
      values: {
        name: "qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        dialect: "qwen",
      },
    },
    {
      id: "ark",
      label: T("火山方舟", "Volcano Ark"),
      values: { name: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", dialect: "ark" },
    },
    {
      id: "generic",
      label: T("其他兼容服务", "Other compatible service"),
      values: { dialect: "generic" },
    },
  ],
};

/** The deployment config: endpoints, and their API keys by endpoint name. */
export const FakeConfigFormSchema = ui(
  z
    .object({
      endpoints: ui(
        z
          .array(EndpointSchema)
          .min(1)
          .refine((es) => new Set(es.map((e) => e.name)).size === es.length, {
            params: { ui: "duplicateEndpoint" },
          }),
        ENDPOINTS,
      ),
      apiKeys: secret(z.record(z.string(), z.string().min(1))).default({}),
    })
    .superRefine((cfg, ctx) => {
      cfg.endpoints.forEach((e, i) => {
        if (acceptsPdf(e.dialect)) return;
        e.models.forEach((m, j) => {
          if (m.documents !== true) return;
          ctx.addIssue({
            code: "custom",
            path: ["endpoints", i, "models", j, "documents"],
            message: `dialect "${e.dialect}" does not accept PDF documents; documents must be false`,
            params: { ui: "pdfDialect" },
          });
        });
      });
      const names = new Set(cfg.endpoints.map((e) => e.name));
      for (const key of Object.keys(cfg.apiKeys)) {
        if (names.has(key)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["apiKeys", key],
          message: `apiKeys["${key}"] does not match any endpoint name`,
          params: { ui: "unknownKey" },
        });
      }
    }),
  {
    messages: {
      duplicateEndpoint: T("端点名称重复", "Endpoint names must be unique"),
      duplicateModel: T("模型 ID 重复", "Model ids must be unique within an endpoint"),
      pdfDialect: T(
        "该方言不支持 PDF，请取消勾选",
        "This dialect does not accept PDF; clear the box",
      ),
      unknownKey: T("密钥没有对应的端点", "This key has no endpoint"),
    },
  },
);

export default defineExtension({
  name: "fake-config-form",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: FakeConfigFormSchema },
  setup(ctx) {
    FakeConfigFormSchema.parse(ctx.config ?? {});
  },
});
