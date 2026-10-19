import { describe, expect, it } from "vitest";
import {
  type ChannelCard,
  type InputForm,
  questionRenderableInline,
  renderCardAsText,
  validateChannelCard,
} from "../src/index.js";

const opts = (n: number) => Array.from({ length: n }, (_, i) => `o${i + 1}`);

const enumForm = (n: number, extra: Partial<InputForm["fields"][number]> = {}): InputForm => ({
  title: "Pick",
  fields: [{ key: "k", label: "K", schema: { type: "string", enum: opts(n) }, ...extra }],
});

describe("questionRenderableInline", () => {
  it("单选 ≤ 5 项可在 IM 内答，6 项不行", () => {
    expect(questionRenderableInline(enumForm(1))).toBe(true);
    expect(questionRenderableInline(enumForm(5))).toBe(true);
    expect(questionRenderableInline(enumForm(6))).toBe(false);
  });

  it("多选 ≤ 10 项可在 IM 内答，11 项不行", () => {
    expect(questionRenderableInline(enumForm(10, { multiSelect: true }))).toBe(true);
    expect(questionRenderableInline(enumForm(11, { multiSelect: true }))).toBe(false);
  });

  it("两个字段不行", () => {
    const f = enumForm(2);
    f.fields.push({ key: "k2", label: "K2", schema: { type: "string", enum: ["a"] } });
    expect(questionRenderableInline(f)).toBe(false);
  });

  it("文本 / 布尔 / 数字字段不行", () => {
    for (const schema of [
      { type: "string" as const },
      { type: "string" as const, maxLength: 10 },
      { type: "boolean" as const },
      { type: "number" as const },
    ]) {
      expect(
        questionRenderableInline({ title: "t", fields: [{ key: "k", label: "K", schema }] }),
      ).toBe(false);
    }
  });

  it("带「其他 / 自由文本」选项不行", () => {
    expect(questionRenderableInline(enumForm(2, { allowOther: true }))).toBe(false);
    expect(questionRenderableInline(enumForm(2, { allowOther: true, multiSelect: true }))).toBe(
      false,
    );
  });

  it("零字段不行", () => {
    expect(questionRenderableInline({ title: "t", fields: [] })).toBe(false);
  });
});

const approval: Extract<ChannelCard, { kind: "approval" }> = {
  kind: "approval",
  id: "ap_1",
  title: "Create issue",
  toolName: "create_issue",
  appName: "GitHub",
  agentName: "Helper",
  inputPreview: '{"title":"bug"}',
  scopes: ["once", "session", "always"],
  expiresAt: "2026-10-19T12:00:00.000Z",
  state: "pending",
};

const question: Extract<ChannelCard, { kind: "question" }> = {
  kind: "question",
  id: "q_1",
  form: { ...enumForm(3), title: { zh: "选择环境", en: "Pick env" } },
  state: "pending",
  webUrl: "https://capy.example.com/c/1?q=q_1",
};

const connect: ChannelCard = {
  kind: "connect",
  appName: "GitHub",
  url: "https://capy.example.com/apps/gh/connect",
};
const bind: ChannelCard = {
  kind: "bind",
  url: "https://capy.example.com/bind?t=x",
  text: "Bind your account first.",
};

describe("validateChannelCard", () => {
  it("四类合法卡片无错误", () => {
    for (const c of [approval, question, connect, bind]) expect(validateChannelCard(c)).toEqual([]);
    expect(
      validateChannelCard({ ...approval, appName: undefined, state: "approved", decidedBy: "bob" }),
    ).toEqual([]);
    expect(validateChannelCard({ ...question, state: "answered", answerSummary: "o1" })).toEqual(
      [],
    );
    expect(validateChannelCard({ ...approval, expiresAt: "2026-10-19T12:00:00+08:00" })).toEqual(
      [],
    );
  });

  it("非对象或未知 kind", () => {
    expect(validateChannelCard(null).length).toBeGreaterThan(0);
    expect(validateChannelCard("x").length).toBeGreaterThan(0);
    expect(validateChannelCard({ kind: "nope" })).toEqual([
      'kind must be one of "approval", "question", "connect", "bind"',
    ]);
  });

  it("approval：必填字符串、scopes、expiresAt、state", () => {
    expect(validateChannelCard({ ...approval, id: "" })).toEqual(["id must be a non-empty string"]);
    expect(validateChannelCard({ ...approval, title: 1 })).toEqual([
      "title must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...approval, toolName: "" })).toEqual([
      "toolName must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...approval, agentName: undefined })).toEqual([
      "agentName must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...approval, inputPreview: 3 })).toEqual([
      "inputPreview must be a string",
    ]);
    expect(validateChannelCard({ ...approval, appName: "" })).toEqual([
      "appName must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...approval, decidedBy: "" })).toEqual([
      "decidedBy must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...approval, scopes: [] })).toEqual([
      'scopes must be a non-empty array of "once", "session", "always" without duplicates',
    ]);
    expect(validateChannelCard({ ...approval, scopes: ["once", "once"] }).length).toBe(1);
    expect(validateChannelCard({ ...approval, scopes: ["forever"] }).length).toBe(1);
    expect(validateChannelCard({ ...approval, scopes: "once" }).length).toBe(1);
    expect(validateChannelCard({ ...approval, expiresAt: "tomorrow" })).toEqual([
      "expiresAt must be an ISO 8601 timestamp",
    ]);
    expect(validateChannelCard({ ...approval, expiresAt: "2026-13-40T99:00:00Z" }).length).toBe(1);
    expect(validateChannelCard({ ...approval, state: "answered" })).toEqual([
      'state must be one of "pending", "approved", "denied", "expired", "cancelled"',
    ]);
  });

  it("question：id、state、webUrl、form", () => {
    expect(validateChannelCard({ ...question, id: "" })).toEqual(["id must be a non-empty string"]);
    expect(validateChannelCard({ ...question, state: "approved" })).toEqual([
      'state must be one of "pending", "answered", "expired", "cancelled"',
    ]);
    expect(validateChannelCard({ ...question, webUrl: "javascript:alert(1)" })).toEqual([
      "webUrl must be an absolute http(s) URL",
    ]);
    expect(validateChannelCard({ ...question, answerSummary: 1 })).toEqual([
      "answerSummary must be a string",
    ]);
    expect(validateChannelCard({ ...question, form: { title: "t", fields: [] } })).toEqual([
      "form: form must have at least one field",
    ]);
    expect(validateChannelCard({ ...question, form: undefined })).toEqual([
      "form: form.fields must be an array",
    ]);
  });

  it("connect / bind：必填字符串与 url", () => {
    expect(validateChannelCard({ ...connect, appName: "" })).toEqual([
      "appName must be a non-empty string",
    ]);
    expect(validateChannelCard({ ...connect, url: "ftp://x" })).toEqual([
      "url must be an absolute http(s) URL",
    ]);
    expect(validateChannelCard({ ...bind, text: "" })).toEqual(["text must be a non-empty string"]);
    expect(validateChannelCard({ ...bind, url: "not a url" })).toEqual([
      "url must be an absolute http(s) URL",
    ]);
  });
});

describe("renderCardAsText", () => {
  it("approval 待审批：en / zh", () => {
    expect(renderCardAsText(approval, "en")).toBe(
      [
        "[Approval] Create issue",
        "Tool: GitHub / create_issue",
        "Agent: Helper",
        'Input: {"title":"bug"}',
        "Status: Pending",
        "Expires: 2026-10-19T12:00:00.000Z",
        "Cards are not supported here. Please approve or deny on the web.",
      ].join("\n"),
    );
    expect(renderCardAsText(approval, "zh")).toBe(
      [
        "【审批】Create issue",
        "工具：GitHub / create_issue",
        "Agent：Helper",
        '输入：{"title":"bug"}',
        "状态：待审批",
        "过期时间：2026-10-19T12:00:00.000Z",
        "此处不支持卡片，请到网页上批准或拒绝。",
      ].join("\n"),
    );
  });

  it("approval 已决定：无网页提示，带决定人，无应用名时只给工具名", () => {
    const { appName: _a, ...noApp } = approval;
    const c: ChannelCard = { ...noApp, state: "approved", decidedBy: "bob" };
    expect(renderCardAsText(c, "en")).toBe(
      [
        "[Approval] Create issue",
        "Tool: create_issue",
        "Agent: Helper",
        'Input: {"title":"bug"}',
        "Status: Approved (bob)",
      ].join("\n"),
    );
    expect(renderCardAsText({ ...noApp, state: "denied" }, "zh")).toBe(
      [
        "【审批】Create issue",
        "工具：create_issue",
        "Agent：Helper",
        '输入：{"title":"bug"}',
        "状态：已拒绝",
      ].join("\n"),
    );
  });

  it("question：en / zh，按语言取标题", () => {
    expect(renderCardAsText(question, "en")).toBe(
      [
        "[Question] Pick env",
        "Status: Pending",
        "Answer on the web: https://capy.example.com/c/1?q=q_1",
      ].join("\n"),
    );
    expect(renderCardAsText(question, "zh")).toBe(
      ["【提问】选择环境", "状态：待回答", "到网页上回答：https://capy.example.com/c/1?q=q_1"].join(
        "\n",
      ),
    );
    const answered: ChannelCard = {
      ...question,
      form: { ...question.form, title: "Plain" },
      state: "answered",
      answerSummary: "o1",
    };
    expect(renderCardAsText(answered, "en")).toBe(
      [
        "[Question] Plain",
        "Status: Answered",
        "Answer: o1",
        "Details: https://capy.example.com/c/1?q=q_1",
      ].join("\n"),
    );
    expect(renderCardAsText(answered, "zh")).toBe(
      [
        "【提问】Plain",
        "状态：已回答",
        "回答：o1",
        "详情：https://capy.example.com/c/1?q=q_1",
      ].join("\n"),
    );
  });

  it("connect：en / zh", () => {
    expect(renderCardAsText(connect, "en")).toBe(
      "[Connect] GitHub needs to be connected.\nConnect: https://capy.example.com/apps/gh/connect",
    );
    expect(renderCardAsText(connect, "zh")).toBe(
      "【连接】需要连接 GitHub。\n连接：https://capy.example.com/apps/gh/connect",
    );
  });

  it("bind：文案原样 + 链接（两种语言相同）", () => {
    const want = "Bind your account first.\nhttps://capy.example.com/bind?t=x";
    expect(renderCardAsText(bind, "en")).toBe(want);
    expect(renderCardAsText(bind, "zh")).toBe(want);
  });

  it("各状态文案齐全", () => {
    for (const state of ["pending", "approved", "denied", "expired", "cancelled"] as const) {
      expect(renderCardAsText({ ...approval, state }, "en")).not.toContain("undefined");
      expect(renderCardAsText({ ...approval, state }, "zh")).not.toContain("undefined");
    }
    for (const state of ["pending", "answered", "expired", "cancelled"] as const) {
      expect(renderCardAsText({ ...question, state }, "en")).not.toContain("undefined");
      expect(renderCardAsText({ ...question, state }, "zh")).not.toContain("undefined");
    }
  });
});
