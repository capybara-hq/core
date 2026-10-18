import type { ElicitationRequest } from "@capybara-hq/plugin-sdk";
import { validateAnswer } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  ElicitationSession,
  elicitationForm,
  UNSUPPORTED_ELICITATION_NOTE,
} from "../../src/tools/elicitation.js";

const form = (
  requestedSchema: Record<string, unknown>,
  message = "Tell me",
): ElicitationRequest => ({
  mode: "form",
  message,
  requestedSchema,
});

const URL_REQ: ElicitationRequest = {
  mode: "url",
  message: "Connect your bank",
  url: "https://bank.example.com/connect?state=abc",
  elicitationId: "el-1",
};

describe("elicitationForm：requestedSchema → InputForm", () => {
  it("字符串 / 枚举（enumNames、oneOf）/ 多选 / 布尔 / 数字；title 作标签，required 保留", () => {
    const r = elicitationForm(
      form(
        {
          type: "object",
          properties: {
            name: { type: "string", title: "Your name", description: "Full name", maxLength: 50 },
            email: { type: "string", format: "email" },
            size: { type: "string", enum: ["s", "l"], enumNames: ["Small", "Large"] },
            plan: {
              type: "string",
              oneOf: [
                { const: "free", title: "Free" },
                { const: "pro", title: "Pro" },
              ],
            },
            tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
            agree: { type: "boolean", title: "Agree", default: false },
            count: { type: "integer", minimum: 1, maximum: 9 },
          },
          required: ["name", "agree"],
        },
        "Please fill in",
      ),
    );
    expect("form" in r && r.form).toEqual({
      title: "Please fill in",
      fields: [
        {
          key: "name",
          label: "Your name",
          description: "Full name",
          schema: { type: "string", maxLength: 50 },
          required: true,
        },
        {
          key: "email",
          label: "email",
          description: "Format: email.",
          schema: { type: "string" },
        },
        {
          key: "size",
          label: "size",
          description: "Options: s = Small; l = Large.",
          schema: { type: "string", enum: ["s", "l"] },
        },
        {
          key: "plan",
          label: "plan",
          description: "Options: free = Free; pro = Pro.",
          schema: { type: "string", enum: ["free", "pro"] },
        },
        {
          key: "tags",
          label: "tags",
          schema: { type: "string", enum: ["a", "b"] },
          multiSelect: true,
        },
        {
          key: "agree",
          label: "Agree",
          description: "Default: false.",
          schema: { type: "boolean" },
          required: true,
        },
        {
          key: "count",
          label: "count",
          schema: { type: "integer", minimum: 1, maximum: 9 },
        },
      ],
    });
  });

  it("超出子集 → unsupported（带原因）", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ type: "object", properties: { o: { type: "object" } } }, /"o".*unsupported type/],
      [{ type: "object", properties: { s: { type: "string", minLength: 3 } } }, /"s".*minLength/],
      [
        {
          type: "object",
          properties: { t: { type: "array", items: { type: "string", enum: ["a"] }, minItems: 2 } },
        },
        /"t".*minItems/,
      ],
      [{ type: "object", properties: {} }, /no fields/],
      [{ type: "string" }, /object/],
    ];
    for (const [schema, why] of cases) {
      const r = elicitationForm(form(schema));
      expect("unsupported" in r && r.unsupported, JSON.stringify(schema)).toMatch(why);
    }
  });

  it("url 模式：表单带 url 与必填的「已完成」开关", () => {
    const r = elicitationForm(URL_REQ);
    expect("form" in r && r.form).toEqual({
      title: "Connect your bank",
      url: "https://bank.example.com/connect?state=abc",
      fields: [
        {
          key: "completed",
          label: { en: "I have completed this step", zh: "我已完成这一步" },
          schema: { type: "boolean" },
          required: true,
        },
      ],
    });
  });

  it("映射出的表单能校验真实答案", () => {
    const r = elicitationForm(
      form({
        type: "object",
        properties: { n: { type: "number", minimum: 0 }, s: { type: "string" } },
        required: ["s"],
      }),
    );
    if (!("form" in r)) throw new Error("expected form");
    expect(validateAnswer(r.form, { s: "x", n: 2 })).toEqual([]);
    expect(validateAnswer(r.form, { n: -1 }).length).toBeGreaterThan(0);
  });
});

describe("ElicitationSession", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };

  it("首次：记下待问的表单、中止调用，答复永不 resolve", async () => {
    let aborted = 0;
    const s = new ElicitationSession({ onSuspend: () => aborted++ });
    let settled = false;
    void s.handle(form(schema)).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(1);
    expect(settled).toBe(false);
    expect(s.pending?.form.fields.map((f) => f.key)).toEqual(["name"]);
    expect(s.pending?.state).toMatchObject({ elicitation: { answers: [] } });
  });

  it("续跑：同样的 requestedSchema → 用答案立即 accept；答案只用一次", async () => {
    const first = new ElicitationSession({ onSuspend: () => {} });
    void first.handle(form(schema, "Who are you?"));
    const state = first.pending?.state;

    const s = new ElicitationSession({
      resume: { state, answer: { name: "Ada" } },
      onSuspend: () => {
        throw new Error("should not suspend");
      },
    });
    // message 不同不影响匹配（只按 requestedSchema）
    await expect(s.handle(form(schema, "Who are you, again?"))).resolves.toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
    expect(s.pending).toBeUndefined();

    // 第二次同样的请求：答案已用过 → 再问（带上已有答案，便于下一次续跑整条重放）
    let suspended = 0;
    const s2 = new ElicitationSession({
      resume: { state, answer: { name: "Ada" } },
      onSuspend: () => suspended++,
    });
    await s2.handle(form(schema));
    void s2.handle(form(schema));
    await new Promise((r) => setTimeout(r, 10));
    expect(suspended).toBe(1);
    expect(s2.pending?.state).toMatchObject({
      elicitation: { answers: [{ response: { action: "accept", content: { name: "Ada" } } }] },
    });
  });

  it("续跑时 answer 为 null（超时 / 取消）→ cancel", async () => {
    const first = new ElicitationSession({ onSuspend: () => {} });
    void first.handle(form(schema));
    const s = new ElicitationSession({
      resume: { state: first.pending?.state, answer: null },
      onSuspend: () => {},
    });
    await expect(s.handle(form(schema))).resolves.toEqual({ action: "cancel" });
  });

  it("续跑时远端换了 schema → 不匹配，重新询问", async () => {
    const first = new ElicitationSession({ onSuspend: () => {} });
    void first.handle(form(schema));
    let suspended = 0;
    const s = new ElicitationSession({
      resume: { state: first.pending?.state, answer: { name: "Ada" } },
      onSuspend: () => suspended++,
    });
    void s.handle(form({ type: "object", properties: { age: { type: "integer" } } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(suspended).toBe(1);
  });

  it("url：已完成 → accept；未勾选 → decline；地址只按 origin + path 匹配", async () => {
    const first = new ElicitationSession({ onSuspend: () => {} });
    void first.handle(URL_REQ);
    const state = first.pending?.state;
    const again = { ...URL_REQ, url: "https://bank.example.com/connect?state=xyz" };
    const yes = new ElicitationSession({
      resume: { state, answer: { completed: true } },
      onSuspend: () => {},
    });
    await expect(yes.handle(again)).resolves.toEqual({ action: "accept" });
    const no = new ElicitationSession({
      resume: { state, answer: { completed: false } },
      onSuspend: () => {},
    });
    await expect(no.handle(again)).resolves.toEqual({ action: "decline" });
  });

  it("超出子集 → 立即 decline 并记一条给模型的说明；不中止", async () => {
    let suspended = 0;
    const s = new ElicitationSession({ onSuspend: () => suspended++ });
    await expect(
      s.handle(form({ type: "object", properties: { o: { type: "object" } } })),
    ).resolves.toEqual({ action: "decline" });
    expect(suspended).toBe(0);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toContain(UNSUPPORTED_ELICITATION_NOTE);
  });

  it("declineAll（如 resources 工具）：一律 decline 并记说明", async () => {
    const s = new ElicitationSession({ onSuspend: () => {}, declineAll: true });
    await expect(s.handle(form(schema))).resolves.toEqual({ action: "decline" });
    expect(s.notes).toHaveLength(1);
  });
});
