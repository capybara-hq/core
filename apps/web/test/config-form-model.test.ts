import { describe, expect, it } from "vitest";
import {
  type ArrayNode,
  buildTree,
  type ConfigNode,
  type Draft,
  fromDraft,
  mapIssues,
  newItemDraft,
  nodeId,
  type ObjectNode,
  toDraft,
} from "../src/components/config-form/model";
import type { JsonSchema } from "../src/lib/json-schema";
import SCHEMA from "./support/openai-compatible-schema.json";

// The openai-compatible schema of the config forms spec §6, as `configJsonSchema` emits it.
const schema = SCHEMA as JsonSchema;

const child = (n: ConfigNode, key: string): ConfigNode => {
  if (n.kind !== "object") throw new Error(`${n.key} is not an object`);
  const c = n.children.find((x) => x.key === key);
  if (!c) throw new Error(`no ${key}`);
  return c;
};

const VALUE = {
  endpoints: [
    {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      dialect: "deepseek",
      models: [{ id: "deepseek-chat", contextWindow: 128000, maxOutputTokens: 8192 }],
    },
    {
      name: "a.b",
      baseUrl: "http://vllm.internal/v1",
      dialect: "generic",
      models: [
        { id: "m1", contextWindow: 1000, maxOutputTokens: 100 },
        { id: "m2", contextWindow: 2000, maxOutputTokens: 200, documents: true },
      ],
    },
  ],
};

describe("buildTree", () => {
  it("draws endpoints as a repeater of objects, the key after baseUrl, models as rows", () => {
    const root = buildTree(schema, "zh");
    // apiKeys is drawn per endpoint, not on its own
    expect(root.children.map((c) => c.key)).toEqual(["endpoints"]);
    const endpoints = child(root, "endpoints") as ArrayNode;
    expect(endpoints.kind).toBe("array");
    expect(endpoints.label).toBe("端点");
    expect(endpoints.title).toBe("{name}");
    expect(endpoints.subtitle).toBe("{baseUrl}");
    expect(endpoints.addLabel).toBe("添加端点");
    expect(endpoints.reorder).toBe(true);
    expect(endpoints.minItems).toBe(1);
    expect(endpoints.presets.map((p) => p.label)).toEqual(["DeepSeek", "其他兼容服务"]);
    const item = endpoints.item as ObjectNode;
    expect(item.children.map((c) => c.key)).toEqual([
      "name",
      "baseUrl",
      "$secret:apiKeys",
      "dialect",
      "midConversationSystem",
      "models",
    ]);
    const key = child(item, "$secret:apiKeys");
    expect(key).toMatchObject({
      kind: "itemSecret",
      path: "apiKeys",
      keyBy: "name",
      label: "API 密钥",
    });
    expect(child(item, "dialect")).toMatchObject({ kind: "scalar", widget: "select" });
    expect(
      (child(item, "dialect") as { options: { label: string }[] }).options.map((o) => o.label),
    ).toEqual(["通用（vLLM 等）", "DeepSeek", "通义千问（百炼）", "火山方舟"]);
    expect(child(item, "midConversationSystem")).toMatchObject({
      widget: "tristate",
      advanced: true,
    });
    const models = child(item, "models") as ArrayNode;
    const row = models.item as ObjectNode;
    expect(row.layout).toBe("row");
    expect(child(row, "contextWindow")).toMatchObject({
      type: "integer",
      unit: "tokens",
      required: true,
    });
    expect(child(row, "vision")).toMatchObject({ widget: "checkbox", required: false });
    expect(child(row, "streamIdleTimeoutMs")).toMatchObject({ advanced: true, unit: "毫秒" });
    // every node under the array belongs to the field `endpoints`
    expect(child(row, "vision").fieldPath).toBe("endpoints");
    expect(key.fieldPath).toBe("apiKeys");
  });

  it("labels in the page locale, else title, else the key", () => {
    const en = buildTree(schema, "en");
    expect(child(en, "endpoints").label).toBe("Endpoints");
    const plain = buildTree(
      {
        type: "object",
        properties: { region: { type: "string" }, zone: { type: "string", title: "Zone" } },
      },
      "zh",
    );
    expect(plain.children.map((c) => c.label)).toEqual(["region", "Zone"]);
  });

  it("orders by x-ui.order, then declaration; keeps sections on the root", () => {
    const root = buildTree(
      {
        type: "object",
        "x-ui": {
          sections: [
            { id: "conn", label: { zh: "连接", en: "Connection" } },
            { id: "keys", label: { zh: "凭据", en: "Credentials" } },
          ],
        },
        properties: {
          a: { type: "string" },
          b: { type: "string", "x-ui": { order: -1, section: "keys" } },
          c: { type: "string", "x-ui": { order: 2 } },
          d: { type: "string", "x-ui": { section: "conn" } },
        },
      },
      "en",
    );
    expect(root.children.map((c) => c.key)).toEqual(["b", "a", "d", "c"]);
    expect(root.sections.map((s) => s.label)).toEqual(["Connection", "Credentials"]);
    expect(child(root, "b").section).toBe("keys");
  });

  it("unions, tuples and x-unsupported are JSON; records of scalars key / value; nullable is its member", () => {
    const root = buildTree(
      {
        type: "object",
        properties: {
          u: { anyOf: [{ type: "string" }, { type: "number" }] },
          t: { type: "array", prefixItems: [{ type: "string" }], items: { type: "string" } },
          x: { "x-unsupported": true },
          headers: { type: "object", additionalProperties: { type: "string" } },
          n: { anyOf: [{ type: "integer" }, { type: "null" }] },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      "en",
    );
    expect(root.children.map((c) => c.kind)).toEqual([
      "json",
      "json",
      "json",
      "record",
      "scalar",
      "array",
    ]);
  });
});

describe("drafts", () => {
  const root = buildTree(schema, "en");

  it("round-trips a value", () => {
    const draft = toDraft(root, VALUE);
    const { value, problems } = fromDraft(root, draft);
    expect(problems).toEqual([]);
    expect(value).toEqual(VALUE);
  });

  it("an emptied number is a required problem, never NaN", () => {
    const draft = toDraft(root, VALUE) as Extract<Draft, { t: "object" }>;
    const endpoints = draft.fields.endpoints as Extract<Draft, { t: "array" }>;
    const first = endpoints.items[0]?.draft as Extract<Draft, { t: "object" }>;
    const models = first.fields.models as Extract<Draft, { t: "array" }>;
    const model = models.items[0]?.draft as Extract<Draft, { t: "object" }>;
    model.fields.contextWindow = { t: "text", text: "" };
    const { value, problems } = fromDraft(root, draft);
    expect(problems).toEqual([
      expect.objectContaining({
        id: nodeId(["endpoints", 0, "models", 0, "contextWindow"]),
        kind: "required",
        label: "Context window",
      }),
    ]);
    expect(JSON.stringify(value)).not.toContain("NaN");
  });

  it("a new endpoint with an empty name is a problem on name; a preset prefills", () => {
    const endpoints = child(root, "endpoints") as ArrayNode;
    const blank = newItemDraft(endpoints);
    const { problems } = fromDraft(endpoints.item, blank, {}, ["endpoints", 2]);
    expect(problems.map((p) => p.id)).toContain(nodeId(["endpoints", 2, "name"]));
    expect(problems.find((p) => p.id === nodeId(["endpoints", 2, "name"]))?.kind).toBe("required");
    const preset = newItemDraft(endpoints, endpoints.presets[0]?.values);
    const r = fromDraft(endpoints.item, preset);
    expect(r.value).toMatchObject({
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      dialect: "deepseek",
    });
  });

  it("checks types and limits", () => {
    const models = (child(root, "endpoints") as ArrayNode).item as ObjectNode;
    const row = (child(models, "models") as ArrayNode).item;
    const draft = toDraft(row, { id: "x", contextWindow: 1, maxOutputTokens: 1 }) as Extract<
      Draft,
      { t: "object" }
    >;
    draft.fields.contextWindow = { t: "text", text: "1.5" };
    draft.fields.maxOutputTokens = { t: "text", text: "0" };
    expect(fromDraft(row, draft).problems.map((p) => p.kind)).toEqual(["integer", "gt"]);
  });
});

describe("mapIssues", () => {
  const root = buildTree(
    {
      ...schema,
      "x-ui": {
        messages: {
          pdfDialect: {
            zh: "该方言不支持 PDF，请取消勾选",
            en: "This dialect does not accept PDF",
          },
        },
      },
    },
    "zh",
  );

  it("maps segments to the node, record keys to the item's key input, arrays to the repeater", () => {
    const { byNode, form } = mapIssues(root, VALUE, [
      {
        path: "endpoints.1.models.1.documents",
        segments: ["endpoints", 1, "models", 1, "documents"],
        message: "invalid value",
        messageKey: "pdfDialect",
      },
      { path: "apiKeys.a.b", segments: ["apiKeys", "a.b"], message: "too small (minimum 1)" },
      { path: "endpoints", segments: ["endpoints"], message: "invalid value" },
      { path: "nope.x", segments: ["nope", "x"], message: "unrecognized keys" },
      { path: "", segments: [], message: "invalid value" },
    ]);
    expect(byNode.get(nodeId(["endpoints", 1, "models", 1, "documents"]))).toBe(
      "该方言不支持 PDF，请取消勾选",
    );
    expect(byNode.get(nodeId(["endpoints", 1, "$secret:apiKeys"]))).toBe("too small (minimum 1)");
    expect(byNode.get(nodeId(["endpoints"]))).toBe("invalid value");
    expect(form).toEqual(["nope.x: unrecognized keys", "invalid value"]);
  });

  it("falls back to the dotted path when segments are missing", () => {
    const { byNode } = mapIssues(root, VALUE, [
      { path: "endpoints.0.baseUrl", message: "invalid url" },
    ]);
    expect(byNode.get(nodeId(["endpoints", 0, "baseUrl"]))).toBe("invalid url");
  });
});
