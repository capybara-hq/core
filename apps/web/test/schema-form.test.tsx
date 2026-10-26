import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import {
  draftToConfig,
  initialDraft,
  type SchemaDraft,
  SchemaForm,
  type SchemaMode,
  type SecretState,
  schemaFields,
} from "../src/components/SchemaForm";
import type { JsonSchema } from "../src/lib/json-schema";

afterEach(cleanup);

/** 与内核 configToJsonSchema 的输出同形：密钥带 x-secret、无 default。 */
const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    platformUrl: { type: "string", format: "uri", description: "Platform base URL" },
    appId: { type: "string", minLength: 1 },
    tenant: { type: "string", default: "t1" },
    retries: { type: "integer", default: 3 },
    ratio: { type: "number" },
    verbose: { type: "boolean", default: false },
    region: { type: "string", enum: ["cn", "global"] },
    appSecret: { type: "string", minLength: 1, "x-secret": true },
    webhookToken: { type: "string", "x-secret": true },
    headers: { type: "object", additionalProperties: { type: "string" } },
    when: { "x-unsupported": true },
  },
  required: ["platformUrl", "appId", "appSecret", "region"],
};

function Harness({
  mode,
  config = null,
  secrets,
  onDraft,
  locale = "en",
  showRequired = false,
}: {
  mode: SchemaMode;
  config?: Record<string, unknown> | null;
  secrets?: SecretState;
  onDraft?: (d: SchemaDraft) => void;
  locale?: "zh" | "en";
  showRequired?: boolean;
}) {
  const [draft, setDraft] = useState(() => initialDraft(SCHEMA, config));
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <SchemaForm
        schema={SCHEMA}
        draft={draft}
        mode={mode}
        showRequired={showRequired}
        {...(secrets ? { secrets } : {})}
        onChange={(d) => {
          setDraft(d);
          onDraft?.(d);
        }}
      />
    </NextIntlClientProvider>
  );
}

const fields = schemaFields(SCHEMA);

describe("schemaFields / initialDraft", () => {
  it("按 properties 顺序识别各类型；对象与 x-unsupported 退回 JSON", () => {
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["platformUrl", "string", true],
      ["appId", "string", true],
      ["tenant", "string", false],
      ["retries", "integer", false],
      ["ratio", "number", false],
      ["verbose", "boolean", false],
      ["region", "enum", true],
      ["appSecret", "secret", true],
      ["webhookToken", "secret", false],
      ["headers", "json", false],
      ["when", "json", false],
    ]);
    expect(fields[0]?.help).toBe("Platform base URL");
  });

  it("初始草稿：已存配置优先，其次 default；密钥从「保留」开始", () => {
    const d = initialDraft(SCHEMA, { appId: "cli_1", headers: { a: "b" } });
    expect(d).toMatchObject({
      platformUrl: "",
      appId: "cli_1",
      tenant: "t1",
      retries: "3",
      verbose: false,
      appSecret: undefined,
      headers: JSON.stringify({ a: "b" }, null, 2),
    });
  });
});

describe("draftToConfig", () => {
  const filled: SchemaDraft = {
    ...initialDraft(SCHEMA, null),
    platformUrl: "http://im.test",
    appId: "cli_1",
    region: "cn",
    appSecret: "s3cret",
  };

  it("创建：数字解析、空的可选字段省略、JSON 解析", () => {
    const { config, errors } = draftToConfig(
      fields,
      { ...filled, ratio: "0.5", headers: '{"x":"1"}' },
      "create",
    );
    expect(errors).toEqual({});
    expect(config).toEqual({
      platformUrl: "http://im.test",
      appId: "cli_1",
      tenant: "t1",
      retries: 3,
      ratio: 0.5,
      verbose: false,
      region: "cn",
      appSecret: "s3cret",
      headers: { x: "1" },
    });
  });

  it("错误：必填缺失、非数字、非整数、坏 JSON", () => {
    const { errors } = draftToConfig(
      fields,
      { ...filled, appId: " ", retries: "1.5", ratio: "abc", headers: "{", appSecret: "" },
      "create",
    );
    expect(errors).toEqual({
      appId: "required",
      retries: "integer",
      ratio: "number",
      headers: "json",
      appSecret: "required",
    });
  });

  it("编辑：已设置的密钥 保留 → 省略、清除 → null、替换 → 新值；空的替换框按保留", () => {
    const secrets = [
      { path: "appSecret", set: true },
      { path: "webhookToken", set: true },
    ];
    const keep = draftToConfig(fields, { ...filled, appSecret: undefined }, "edit", secrets);
    expect(keep.errors).toEqual({});
    expect(keep.config).not.toHaveProperty("appSecret");
    expect(keep.config).not.toHaveProperty("webhookToken");
    const changed = draftToConfig(
      fields,
      { ...filled, appSecret: "rotated", webhookToken: null },
      "edit",
      secrets,
    );
    expect(changed.config).toMatchObject({ appSecret: "rotated", webhookToken: null });
    const emptyReplace = draftToConfig(fields, { ...filled, appSecret: "" }, "edit", secrets);
    expect(emptyReplace.config).not.toHaveProperty("appSecret");
    expect(emptyReplace.errors).toEqual({});
  });

  it("编辑：尚未设置的必填密钥仍要填写；未设置的密钥不会发 null", () => {
    const secrets = [{ path: "appSecret", set: false }];
    const r = draftToConfig(
      fields,
      { ...filled, appSecret: undefined, webhookToken: null },
      "edit",
      secrets,
    );
    expect(r.errors).toEqual({ appSecret: "required" });
    expect(r.config).not.toHaveProperty("webhookToken");
  });
});

describe("SchemaForm（渲染）", () => {
  it("各类型的控件：文本、数字、开关、下拉、密码框、JSON 文本框", async () => {
    let last: SchemaDraft = {};
    render(<Harness mode="create" onDraft={(d) => (last = d)} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: /^platformUrl/ }), "http://im.test");
    const retries = screen.getByRole("spinbutton", { name: "retries" });
    expect(retries).toHaveProperty("value", "3");
    await user.clear(retries);
    await user.type(retries, "5");
    await user.click(screen.getByRole("switch", { name: "verbose" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /^region/ }), "global");
    const secret = screen.getByLabelText(/^appSecret/);
    expect(secret.getAttribute("type")).toBe("password");
    await user.type(secret, "s3cret");
    const json = screen.getByRole("textbox", { name: "headers" });
    expect(screen.getAllByText(en.schemaForm.jsonHint).length).toBe(2);
    await user.click(json);
    await user.paste('{"a":"b"}');
    expect(last).toMatchObject({
      platformUrl: "http://im.test",
      retries: "5",
      verbose: true,
      region: "global",
      appSecret: "s3cret",
      headers: '{"a":"b"}',
    });
  });

  it("格式错误随输入显示；必填缺失在 showRequired 时显示", async () => {
    const { unmount } = render(<Harness mode="create" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "headers" }));
    await user.paste("{");
    expect(screen.getByText(`${en.schemaForm.errors.json}`)).toBeTruthy();
    expect(screen.queryByText(`${en.schemaForm.errors.required}`)).toBeNull();
    unmount();
    render(<Harness mode="create" showRequired locale="zh" />);
    // platformUrl、appId、region、appSecret 四个必填
    expect(screen.getAllByText(`${zh.schemaForm.errors.required}`)).toHaveLength(4);
  });

  it("编辑：已设置的密钥只显示「已设置」，可替换 / 取消、可清除 / 撤销；必填密钥不能清除", async () => {
    let last: SchemaDraft = {};
    render(
      <Harness
        mode="edit"
        config={{ platformUrl: "http://im.test", appId: "cli_1", region: "cn" }}
        secrets={[
          { path: "appSecret", set: true },
          { path: "webhookToken", set: true },
        ]}
        onDraft={(d) => (last = d)}
      />,
    );
    const user = userEvent.setup();
    const secret = screen.getByLabelText(/^appSecret/) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe(en.schemaForm.secretSet);
    // 必填：没有清除
    expect(screen.queryByRole("button", { name: "Clear appSecret" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Replace appSecret" }));
    expect(secret.disabled).toBe(false);
    await user.type(secret, "rotated");
    expect(last.appSecret).toBe("rotated");
    await user.click(screen.getByRole("button", { name: "Keep current appSecret" }));
    expect(last.appSecret).toBeUndefined();
    expect(secret.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Clear webhookToken" }));
    expect(last.webhookToken).toBeNull();
    expect((screen.getByLabelText("webhookToken") as HTMLInputElement).placeholder).toBe(
      en.schemaForm.secretWillClear,
    );
    await user.click(screen.getByRole("button", { name: "Keep webhookToken" }));
    expect(last.webhookToken).toBeUndefined();
  });

  it("编辑：尚未设置的密钥直接是密码框（没有替换 / 清除）", () => {
    render(<Harness mode="edit" secrets={[{ path: "appSecret", set: false }]} />);
    const secret = screen.getByLabelText(/^appSecret/) as HTMLInputElement;
    expect(secret.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Replace appSecret" })).toBeNull();
  });
});
