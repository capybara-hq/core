import { DesignProvider, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ConfigForm } from "../src/components/config-form/ConfigForm";
import type { FieldMeta } from "../src/components/config-form/model";
import type { ConfigIssue, JsonSchema } from "../src/lib/json-schema";
import SCHEMA from "./support/openai-compatible-schema.json";

afterEach(cleanup);

function draw(
  schema: JsonSchema,
  value: unknown,
  opts: {
    meta?: Record<string, FieldMeta>;
    issues?: ConfigIssue[];
    locale?: "zh" | "en";
  } = {},
) {
  const locale = opts.locale ?? "en";
  const onChange = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <DesignProvider locale={locale}>
        <ToastProvider>
          <ConfigForm
            schema={schema}
            value={value}
            meta={opts.meta ?? {}}
            issues={opts.issues ?? []}
            onChange={onChange}
          />
        </ToastProvider>
      </DesignProvider>
    </NextIntlClientProvider>,
  );
  return onChange;
}

const PLAIN: JsonSchema = {
  type: "object",
  properties: {
    region: { type: "string" },
    limits: {
      type: "object",
      properties: { burst: { type: "integer" } },
    },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, url: { type: "string" } },
        required: ["name"],
      },
    },
    when: { anyOf: [{ type: "string" }, { type: "number" }] },
    apiKeys: {
      type: "object",
      additionalProperties: { type: "string" },
      "x-secret": true,
    },
  },
  required: ["region"],
};

describe("ConfigForm without hints", () => {
  it("labels from keys, nested objects as groups, arrays of objects as repeaters, unions as JSON", () => {
    draw(PLAIN, { region: "eu", endpoints: [{ name: "a", url: "http://a" }], when: 3 });
    expect((screen.getByLabelText(/^region/) as HTMLInputElement).value).toBe("eu");
    // the nested object is a subsection (an h3 over its fields under the guide), never a card
    // (spec §1 "One box is enough")
    const limits = screen.getByRole("region", { name: "limits" });
    expect(limits.getAttribute("data-part")).toBe("subsection");
    expect(within(limits).getByRole("heading", { level: 3, name: "limits" })).toBeTruthy();
    expect(within(limits).getByLabelText("burst")).toBeTruthy();
    expect(document.querySelector('[data-part="card"]')).toBeNull();
    // array of objects: a repeater with one item, never a JSON textarea
    const list = screen.getByRole("group", { name: "endpoints" });
    const item = within(list).getByRole("group", { name: "Item 1" });
    expect((within(item).getByLabelText(/^name/) as HTMLInputElement).value).toBe("a");
    expect(within(list).getByRole("button", { name: /Add/ })).toBeTruthy();
    // union: JSON
    expect((screen.getByLabelText("when") as HTMLTextAreaElement).value).toBe("3");
    // an unhinted secret record: a whole-record secret, set as key / value rows
    expect(screen.getByRole("group", { name: "apiKeys" })).toBeTruthy();
  });

  it("reports the value; a new item's empty required field is a problem", async () => {
    const onChange = draw(PLAIN, { region: "eu" });
    const user = userEvent.setup();
    const list = screen.getByRole("group", { name: "endpoints" });
    await user.click(within(list).getByRole("button", { name: /Add/ }));
    const [value, entries, state] = onChange.mock.calls.at(-1) as [
      unknown,
      unknown[],
      { problems: { kind: string; id: string }[]; dirty: boolean },
    ];
    expect(value).toEqual({ region: "eu", endpoints: [{}] });
    expect(entries).toEqual([]);
    expect(state.dirty).toBe(true);
    expect(state.problems).toEqual([
      expect.objectContaining({ kind: "required", id: "endpoints/#0/name" }),
    ]);
    expect(screen.getByText(en.configForm.errors.required)).toBeTruthy();
  });

  it("a read-only array disables add, remove and move, and names its source", () => {
    draw(
      {
        type: "object",
        properties: {
          endpoints: {
            type: "array",
            "x-ui": { item: { reorder: true } },
            items: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
      { endpoints: [{ name: "a" }, { name: "b" }] },
      { meta: { endpoints: { readonly: "file" } } },
    );
    const list = screen.getByRole("group", { name: "endpoints" });
    // every button but the collapse toggles (reading stays possible)
    const buttons = within(list)
      .getAllByRole("button")
      .filter((b) => !b.hasAttribute("aria-expanded"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    for (const i of within(list).getAllByRole("textbox"))
      expect((i as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/From the config file/)).toBeTruthy();
  });
});

describe("ConfigForm repeaters", () => {
  const LIST: JsonSchema = {
    type: "object",
    properties: {
      region: { type: "string" },
      endpoints: {
        type: "array",
        "x-ui": {
          item: { title: "{name}" },
          presets: [{ id: "p", label: { zh: "预设", en: "Preset" }, values: { name: "x" } }],
        },
        items: {
          type: "object",
          properties: { name: { type: "string" }, url: { type: "string" } },
          required: ["name", "url"],
        },
      },
    },
  };

  it("undo of a removed item keeps the edits made since", async () => {
    const onChange = draw(LIST, {
      region: "eu",
      endpoints: [
        { name: "a", url: "http://a" },
        { name: "b", url: "http://b" },
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove b" }));
    await user.type(screen.getByLabelText(/^region/), "-west");
    await user.type(within(screen.getByRole("group", { name: "a" })).getByLabelText(/^name/), "2");
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      region: "eu-west",
      endpoints: [
        { name: "a2", url: "http://a" },
        { name: "b", url: "http://b" },
      ],
    });
  });

  it("a preset focuses the new item's first empty required field", async () => {
    draw(LIST, { endpoints: [] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Preset" }));
    await act(async () => {});
    const item = screen.getByRole("group", { name: "x" });
    expect(document.activeElement).toBe(within(item).getByLabelText(/^url/));
  });
});

/** The schema without any hints, as the openai-compatible packed before hints serializes. */
function unhinted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unhinted);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== "x-ui" && k !== "title" && k !== "description")
      .map(([k, x]) => [k, unhinted(x)]),
  );
}

it("the openai-compatible schema without hints: endpoints and their models as repeaters, no JSON", async () => {
  const value = {
    endpoints: [
      {
        name: "vllm",
        baseUrl: "http://vllm.internal/v1",
        dialect: "generic",
        models: [{ id: "qwen3", contextWindow: 32768, maxOutputTokens: 4096 }],
      },
    ],
  };
  draw(unhinted(SCHEMA) as JsonSchema, value, { meta: { apiKeys: { secretSet: true } } });
  const endpoints = screen.getByRole("group", { name: "endpoints" });
  const models = within(endpoints).getByRole("group", { name: "models" });
  expect((within(models).getByLabelText(/^contextWindow/) as HTMLInputElement).value).toBe("32768");
  expect(screen.queryAllByRole("textbox").filter((e) => e.tagName === "TEXTAREA")).toEqual([]);
  // apiKeys: one secret record, replaced or cleared as a whole; the values typed masked
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Replace apiKeys" }));
  const keys = screen.getByRole("group", { name: "apiKeys" });
  await user.click(within(keys).getByRole("button", { name: /Add/ }));
  expect((within(keys).getByLabelText("Value 1") as HTMLInputElement).type).toBe("password");
});

describe("ConfigForm with the openai-compatible hints", () => {
  const VALUE = {
    endpoints: [
      {
        name: "deepseek",
        baseUrl: "https://api.deepseek.com",
        dialect: "deepseek",
        models: [
          { id: "deepseek-chat", contextWindow: 128000, maxOutputTokens: 8192 },
          { id: "deepseek-reasoner", contextWindow: 128000, maxOutputTokens: 32768 },
        ],
      },
    ],
  };

  it("draws endpoint cards with the key input, model rows and localized labels", () => {
    draw(SCHEMA as JsonSchema, VALUE, {
      locale: "zh",
      meta: { apiKeys: { secretSet: true, secretKeys: ["deepseek"] } },
    });
    const list = screen.getByRole("group", { name: "端点" });
    const card = within(list).getByRole("group", { name: "deepseek" });
    expect(within(card).getByText("https://api.deepseek.com")).toBeTruthy();
    // the endpoint's key is set: kept, with replace / clear
    expect(within(card).getByRole("button", { name: "替换 API 密钥" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "清除 API 密钥" })).toBeTruthy();
    const models = within(card).getByRole("group", { name: "模型" });
    expect(within(models).getByRole("group", { name: "deepseek-reasoner" })).toBeTruthy();
    expect(within(models).getAllByRole("group", { name: "选项" }).length).toBe(2);
    expect(within(card).getByRole("button", { name: /添加模型/ })).toBeTruthy();
  });

  it("server issues land on their node: a model's checkbox, an endpoint's key, the form", () => {
    draw(SCHEMA as JsonSchema, VALUE, {
      issues: [
        {
          path: "endpoints.0.models.1.documents",
          segments: ["endpoints", 0, "models", 1, "documents"],
          message: "invalid value",
        },
        { path: "apiKeys.deepseek", segments: ["apiKeys", "deepseek"], message: "too small" },
        { path: "", segments: [], message: "invalid value", messageKey: "duplicateEndpoint" },
      ],
    });
    expect(screen.getByText("PDF documents: invalid value")).toBeTruthy();
    expect(screen.getByText("too small")).toBeTruthy();
    expect(screen.getByText("Endpoint names must be unique")).toBeTruthy();
  });

  it("renaming an endpoint with a key set moves the key", async () => {
    const onChange = draw(SCHEMA as JsonSchema, VALUE, {
      meta: { apiKeys: { secretSet: true, secretKeys: ["deepseek"] } },
    });
    const user = userEvent.setup();
    const card = screen.getByRole("group", { name: "deepseek" });
    const name = within(card).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "ds");
    const [, entries] = onChange.mock.calls.at(-1) as [unknown, unknown[]];
    expect(entries).toEqual([{ path: "apiKeys", key: "ds", renameFrom: "deepseek" }]);
  });
});
