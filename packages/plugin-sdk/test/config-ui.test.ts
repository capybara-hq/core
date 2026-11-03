import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONFIG_UI_LIMITS,
  type ConfigUiHints,
  configJsonSchema,
  isSecret,
  type JsonSchema,
  type LocalizedName,
  parsePluginManifest,
  type StaticExtensionManifest,
  secret,
  ui,
  validateConfigUi,
} from "../src/index.js";

type Props = { properties: Record<string, Record<string, unknown>> };
const T = (zh: string, en: string): LocalizedName => ({ zh, en });

const problems = (
  schema: z.ZodTypeAny,
  level: "deployment" | "org" | "connection" = "deployment",
) => validateConfigUi(configJsonSchema(schema), level);
const paths = (schema: z.ZodTypeAny, level?: "deployment" | "org" | "connection") =>
  problems(schema, level).map((p) => p.path);

/** Every key of every object in a JSON tree, including keys inside `properties`. */
function nodeKeys(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) nodeKeys(n, out);
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      nodeKeys(v, out);
    }
  }
  return out;
}

describe("ui() and secret() merge meta", () => {
  const hints: ConfigUiHints = { label: T("甲", "A") };

  it("ui() then secret() keeps both", () => {
    const s = secret(ui(z.string(), hints));
    expect(s.meta()).toEqual({ secret: true, ui: hints });
    expect(isSecret(s)).toBe(true);
  });

  it("secret() then ui() keeps both", () => {
    const s = ui(secret(z.string()), hints);
    expect(s.meta()).toEqual({ secret: true, ui: hints });
  });

  it("hot meta survives ui()", () => {
    const s = ui(z.number().meta({ hot: true }), hints);
    expect(s.meta()).toEqual({ hot: true, ui: hints });
  });
});

describe("configJsonSchema", () => {
  it("emits x-ui, x-secret, x-hot and fills title from the label", () => {
    const js = configJsonSchema(
      z.object({
        a: ui(z.string(), { label: T("甲", "A"), help: T("帮助", "Help text") }),
        k: secret(z.string()).meta({ hot: true }),
      }),
    );
    const p = (js as unknown as Props).properties;
    expect((p.a?.["x-ui"] as { label: LocalizedName } | undefined)?.label.en).toBe("A");
    expect(p.a?.title).toBe("A");
    expect(p.a?.description).toBe("Help text");
    expect(p.k?.["x-secret"]).toBe(true);
    expect(p.k?.["x-hot"]).toBe(true);
    const keys = nodeKeys(js);
    for (const k of ["hot", "secret", "ui", "$schema"]) expect(keys).not.toContain(k);
  });

  it("keeps an existing title / description", () => {
    const js = configJsonSchema(
      z.object({
        a: ui(z.string().meta({ title: "Own", description: "Own help" }), {
          label: T("甲", "A"),
          help: T("帮助", "Help"),
        }),
      }),
    ) as unknown as Props;
    expect(js.properties.a?.title).toBe("Own");
    expect(js.properties.a?.description).toBe("Own help");
  });

  it("copies the hints (the scrub never mutates the schema's meta)", () => {
    const hints: ConfigUiHints = {
      label: T("甲", "A"),
      options: [{ value: "x", label: T("叉", "X") }],
    };
    const s = z.object({ a: ui(secret(z.enum(["x", "y"])), hints) });
    configJsonSchema(s);
    expect(hints.options).toHaveLength(1);
  });

  // Moved from the kernel's config-json-schema tests.
  it("converts an object, keeping required and defaults", () => {
    const js = configJsonSchema(
      z.object({ appId: z.string(), n: z.number().default(3), tags: z.array(z.string()) }),
    );
    expect(js.type).toBe("object");
    expect(js.required).toEqual(["appId", "tags"]);
    expect((js as unknown as Props).properties.n?.default).toBe(3);
  });

  it("marks secret fields (optional and nested) with x-secret and drops the secret key", () => {
    const js = configJsonSchema(
      z.object({
        appSecret: secret(z.string()),
        webhook: z.object({ token: secret(z.string()).optional(), path: z.string() }),
      }),
    ) as unknown as Props;
    expect(js.properties.appSecret?.["x-secret"]).toBe(true);
    expect(js.properties.appSecret).not.toHaveProperty("secret");
    const wh = js.properties.webhook?.properties as Record<string, Record<string, unknown>>;
    expect(wh.token?.["x-secret"]).toBe(true);
    expect(wh.token).not.toHaveProperty("secret");
    expect(wh.path).not.toHaveProperty("x-secret");
  });

  it("turns unrepresentable types into x-unsupported without throwing", () => {
    const js = configJsonSchema(
      z.object({ when: z.date(), big: z.bigint(), ok: z.string() }),
    ) as unknown as Props;
    expect(js.properties.when).toEqual({ "x-unsupported": true });
    expect(js.properties.big).toEqual({ "x-unsupported": true });
    expect(js.properties.ok).toEqual({ type: "string" });
  });

  it("has no $schema key", () => {
    expect(configJsonSchema(z.object({}))).not.toHaveProperty("$schema");
  });

  it("secret fields carry no default / enum / const (both default forms, optional wrapper)", () => {
    const js = configJsonSchema(
      z.object({
        a: secret(z.string()).default("S3CRET"),
        b: secret(z.string().default("S4")),
        c: secret(z.string()).optional().default("S5"),
        d: secret(z.enum(["S6", "S7"])),
        e: z.string().default("plain"),
      }),
    ) as unknown as Props;
    for (const k of ["a", "b", "c", "d"]) {
      expect(js.properties[k]?.["x-secret"]).toBe(true);
      for (const w of ["default", "examples", "const", "enum"]) {
        expect(js.properties[k]).not.toHaveProperty(w);
      }
    }
    expect(JSON.stringify(js)).not.toMatch(/S3CRET|S4|S5|S6|S7/);
    expect(js.properties.e?.default).toBe("plain");
  });

  it("scrubs every descendant of a secret object / array (properties named default / enum too)", () => {
    const js = configJsonSchema(
      z.object({
        obj: secret(
          z.object({
            a: z.string().default("NESTDEF"),
            b: z.enum(["NESTENUM1", "NESTENUM2"]),
            c: z.literal("NESTCONST"),
            default: z.string().default("PROPDEF"),
            enum: z.object({ deep: z.string().default("DEEPDEF") }),
          }),
        ),
        arr: secret(z.array(z.string().default("ITEMDEF"))),
        open: z.object({ default: z.string().default("PUBLICDEF") }),
      }),
    );
    const text = JSON.stringify(js);
    expect(text).not.toMatch(/NEST|PROPDEF|DEEPDEF|ITEMDEF/);
    const p = (js as unknown as Props).properties;
    const obj = p.obj?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(obj)).toEqual(["a", "b", "c", "default", "enum"]);
    // A property named default in a non-secret object is traversed and kept.
    const open = p.open?.properties as Record<string, Record<string, unknown>>;
    expect(open.default?.default).toBe("PUBLICDEF");
  });

  it("removes x-ui.options and x-ui.presets under a secret node", () => {
    const js = configJsonSchema(
      z.object({
        d: ui(secret(z.enum(["OPTSECRET", "B"])), {
          label: T("甲", "A"),
          options: [{ value: "OPTSECRET", label: T("一", "One") }],
        }),
        arr: secret(
          ui(z.array(z.object({ x: z.string() })), {
            presets: [{ id: "p", label: T("预设", "Preset"), values: { x: "PRESETSECRET" } }],
          }),
        ),
        // A property named `default` under a secret object is still traversed and scrubbed.
        obj: secret(z.object({ default: z.object({ x: z.string().default("DEEPSECRET") }) })),
      }),
    ) as unknown as Props;
    expect(JSON.stringify(js)).not.toMatch(/OPTSECRET|PRESETSECRET|DEEPSECRET/);
    expect((js.properties.d?.["x-ui"] as { label: LocalizedName } | undefined)?.label.en).toBe("A");
    expect(js.properties.d?.["x-ui"]).not.toHaveProperty("options");
    expect(js.properties.arr?.["x-ui"]).not.toHaveProperty("presets");
  });
});

describe("validateConfigUi", () => {
  const item = z.object({
    name: z.string(),
    url: z.string(),
    kind: z.enum(["a", "b"]),
    n: z.number(),
    tags: z.array(z.string()),
    nested: z.object({ x: z.string() }),
    key: secret(z.string()).optional(),
  });

  it("text too long", () => {
    const s = z.object({ a: ui(z.string(), { label: T("甲", "x".repeat(101)) }) });
    expect(paths(s)).toEqual(["a"]);
    const h = z.object({ a: ui(z.string(), { help: T("甲", "x".repeat(501)) }) });
    expect(paths(h)).toEqual(["a"]);
    const p = z.object({ a: ui(z.string(), { placeholder: "x".repeat(201) }) });
    expect(paths(p)).toEqual(["a"]);
  });

  it("text missing a language", () => {
    const s = z.object({
      o: z.object({ a: ui(z.string(), { label: { zh: "", en: "A" } }) }),
      b: ui(z.string(), { label: { en: "B" } as LocalizedName }),
    });
    expect(paths(s)).toEqual(["o.a", "b"]);
  });

  it("option value not in the enum", () => {
    const s = z.object({
      k: ui(z.enum(["a", "b"]), { options: [{ value: "c", label: T("丙", "C") }] }),
    });
    expect(paths(s)).toEqual(["k"]);
  });

  it("duplicate option value", () => {
    const s = z.object({
      k: ui(z.enum(["a", "b"]), {
        options: [
          { value: "a", label: T("甲", "A") },
          { value: "a", label: T("甲", "A2") },
        ],
      }),
    });
    expect(problems(s).map((p) => p.path)).toEqual(["k"]);
  });

  it("switch on a string", () => {
    expect(paths(z.object({ s: ui(z.string(), { widget: "switch" }) }))).toEqual(["s"]);
  });

  it("presets on an array of strings", () => {
    const s = z.object({
      list: ui(z.array(z.string()), {
        presets: [{ id: "p", label: T("预设", "Preset"), values: {} }],
      }),
    });
    expect(paths(s)).toEqual(["list"]);
  });

  it('layout: "row" on an object with an object property', () => {
    const s = z.object({ o: ui(z.object({ a: z.object({ b: z.string() }) }), { layout: "row" }) });
    expect(paths(s)).toEqual(["o"]);
  });

  it("title template naming an unknown field", () => {
    const s = z.object({ list: ui(z.array(item), { item: { title: "{name} {missing}" } }) });
    expect(paths(s)).toEqual(["list"]);
  });

  it("preset key unknown, value of the wrong type, value on a secret", () => {
    const preset = (values: Record<string, unknown>) =>
      z.object({
        list: ui(z.array(item), { presets: [{ id: "p", label: T("预设", "Preset"), values }] }),
      });
    expect(paths(preset({ nope: 1 }))).toEqual(["list"]);
    expect(paths(preset({ n: "1" }))).toEqual(["list"]);
    expect(paths(preset({ kind: "c" }))).toEqual(["list"]);
    expect(paths(preset({ key: "sk-1" }))).toEqual(["list"]);
    expect(paths(preset({ name: "a", n: 1, kind: "b", tags: ["x"] }))).toEqual([]);
  });

  const withSecrets = (path: string, keyBy: string, extra: Record<string, z.ZodTypeAny> = {}) =>
    z.object({
      list: z.object({
        endpoints: ui(z.array(item), {
          secrets: [{ path, keyBy, label: T("密钥", "Key") }],
        }),
      }),
      keys: secret(z.record(z.string(), z.string())).default({}),
      ...extra,
    });

  it("secrets[].path not a secret record", () => {
    expect(paths(withSecrets("keys", "name"))).toEqual([]);
    expect(paths(withSecrets("missing", "name"))).toEqual(["list.endpoints"]);
    expect(
      paths(withSecrets("plain", "name", { plain: z.record(z.string(), z.string()) })),
    ).toEqual(["list.endpoints"]);
    expect(paths(withSecrets("one", "name", { one: secret(z.string()) }))).toEqual([
      "list.endpoints",
    ]);
  });

  it("secrets[].keyBy not a string property", () => {
    expect(paths(withSecrets("keys", "n"))).toEqual(["list.endpoints"]);
    expect(paths(withSecrets("keys", "missing"))).toEqual(["list.endpoints"]);
  });

  it("secrets at level org", () => {
    expect(paths(withSecrets("keys", "name"), "org")).toEqual(["list.endpoints"]);
    expect(paths(withSecrets("keys", "name"), "connection")).toEqual(["list.endpoints"]);
  });

  it("section without root sections", () => {
    expect(paths(z.object({ a: ui(z.string(), { section: "main" }) }))).toEqual(["a"]);
    const ok = ui(z.object({ a: ui(z.string(), { section: "main" }) }), {
      sections: [{ id: "main", label: T("主要", "Main") }],
    });
    expect(paths(ok)).toEqual([]);
  });

  it("messages and sections below the root", () => {
    const s = z.object({
      o: ui(z.object({ a: z.string() }), { messages: { m: T("消息", "Message") } }),
      p: ui(z.object({ a: z.string() }), { sections: [{ id: "x", label: T("节", "X") }] }),
    });
    expect(paths(s)).toEqual(["o", "p"]);
  });

  it("disallowed hint on a secret node", () => {
    const s = z.object({ k: ui(secret(z.string()), { label: T("密钥", "Key"), widget: "text" }) });
    expect(paths(s)).toEqual(["k"]);
    const ok = z.object({
      k: ui(secret(z.string()), { label: T("密钥", "Key"), placeholder: "sk-…", advanced: true }),
    });
    expect(paths(ok)).toEqual([]);
  });

  it("x-ui larger than 64 KiB in one schema", () => {
    const help = T("帮", "h".repeat(CONFIG_UI_LIMITS.helpChars));
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let i = 0; i < 140; i++) shape[`f${i}`] = ui(z.string(), { help });
    const r = problems(z.object(shape));
    expect(r.map((p) => p.path)).toEqual([""]);
    expect(r[0]?.message).toMatch(/64 KiB|65536/);
  });

  it("walks items and additionalProperties with dot paths", () => {
    const s = z.object({
      endpoints: z.array(z.object({ models: ui(z.array(z.string()), { widget: "switch" }) })),
      byName: z.record(z.string(), ui(z.string(), { widget: "number" })),
    });
    expect(paths(s)).toEqual(["endpoints.items.models", "byName.additionalProperties"]);
  });

  it("the openai-compatible example of the spec (§6) has no problems", () => {
    const flag = (zh: string, en: string, help?: LocalizedName) =>
      ui(z.boolean().optional(), { label: T(zh, en), widget: "checkbox", ...(help && { help }) });

    const EndpointModelSchema = ui(
      z.object({
        id: ui(z.string().min(1), {
          label: T("模型 ID", "Model ID"),
          placeholder: "deepseek-chat",
        }),
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
    const uniqueIds = (ms: { id: string }[]) => new Set(ms.map((m) => m.id)).size === ms.length;
    const uniqueNames = (es: { name: string }[]) =>
      new Set(es.map((e) => e.name)).size === es.length;

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
          .refine(uniqueIds, { params: { ui: "duplicateModel" } }),
        {
          label: T("模型", "Models"),
          item: { title: "{id}", addLabel: T("添加模型", "Add model"), reorder: true },
        },
      ),
    });

    const DeploymentConfig = ui(
      z
        .object({
          endpoints: ui(
            z
              .array(EndpointSchema)
              .min(1)
              .refine(uniqueNames, { params: { ui: "duplicateEndpoint" } }),
            {
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
                  values: {
                    name: "deepseek",
                    baseUrl: "https://api.deepseek.com",
                    dialect: "deepseek",
                  },
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
                  values: {
                    name: "ark",
                    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
                    dialect: "ark",
                  },
                },
                {
                  id: "generic",
                  label: T("其他兼容服务", "Other compatible service"),
                  values: { dialect: "generic" },
                },
              ],
            },
          ),
          apiKeys: secret(z.record(z.string(), z.string().min(1))).default({}),
        })
        .superRefine(() => {}),
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

    const js = configJsonSchema(DeploymentConfig);
    expect(validateConfigUi(js, "deployment")).toEqual([]);
    const ep = (js as unknown as Props).properties.endpoints as { items: Props };
    expect(ep.items.properties.baseUrl?.title).toBe("Base URL");
  });
});

describe("plugin.json extension.configSchemas", () => {
  const staticManifest: StaticExtensionManifest = {
    name: "todo",
    version: "1.0.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    requires: [],
    optional: [],
    permissions: {},
    config: { deployment: [], org: [] },
  };
  const manifest = (configSchemas: unknown) => ({
    schemaVersion: 1,
    name: "todo",
    version: "1.0.0",
    publisher: "Capybara",
    description: "A todo list",
    extension: { entry: "./dist/index.mjs", manifest: staticManifest, configSchemas },
  });

  it("accepts deployment and org JSON Schemas", () => {
    const deployment: JsonSchema = configJsonSchema(
      z.object({ a: ui(z.string(), { label: T("甲", "A") }) }),
    );
    const r = parsePluginManifest(manifest({ deployment, org: { type: "object" } }));
    expect(r).not.toHaveProperty("errors");
    expect(r).toMatchObject({ extension: { configSchemas: { deployment } } });
  });

  it("accepts a schema just under the limit", () => {
    const overhead = JSON.stringify({ type: "object", description: "" }).length;
    const fit = {
      type: "object",
      description: "x".repeat(CONFIG_UI_LIMITS.configSchemaBytes - overhead),
    };
    expect(parsePluginManifest(manifest({ deployment: fit }))).not.toHaveProperty("errors");
  });

  it("rejects a schema over the limit (CONFIG_UI_LIMITS.configSchemaBytes)", () => {
    const big = { type: "object", description: "x".repeat(CONFIG_UI_LIMITS.configSchemaBytes) };
    const r = parsePluginManifest(manifest({ deployment: big }));
    expect(r).toHaveProperty("errors");
    expect((r as { errors: string[] }).errors[0]).toMatch(
      /^extension\.configSchemas\.deployment: /,
    );
  });

  it("rejects unknown keys", () => {
    expect(parsePluginManifest(manifest({ channel: {} }))).toHaveProperty("errors");
  });
});
