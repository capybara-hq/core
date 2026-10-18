import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CARDINALITY,
  CONNECTOR_CAPABILITY,
  definePlugin,
  type InputForm,
  ToolError,
  validateAnswer,
  validateInputForm,
  validateToolSpec,
} from "../src/index.js";

const form = (fields: InputForm["fields"]): InputForm => ({ title: "Pick", fields });

describe("connector@1 能力", () => {
  it("已登记为 multi，definePlugin 接受 provides connector@1", () => {
    expect(CONNECTOR_CAPABILITY).toBe("connector@1");
    expect(CAPABILITY_CARDINALITY.connector).toBe("multi");
    const m = definePlugin({
      name: "demo-conn",
      version: "1.0.0",
      sdk: "^0.1.0",
      provides: ["connector@1"],
      setup() {},
    });
    expect(m.provides).toEqual(["connector@1"]);
  });
});

describe("ToolError", () => {
  it("可用 instanceof 识别并保留消息", () => {
    const e = new ToolError("Upstream is down; retry later.");
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("Upstream is down; retry later.");
  });
});

describe("validateToolSpec", () => {
  const ok = { name: "do_it-2", description: "Does it.", inputSchema: { type: "object" } };
  it("合法声明通过", () => expect(validateToolSpec(ok)).toEqual([]));
  it("非法名称 / 空描述被报告", () => {
    expect(validateToolSpec({ ...ok, name: "bad name" }).join()).toMatch(/name/);
    expect(validateToolSpec({ ...ok, name: "a".repeat(41) }).join()).toMatch(/name/);
    expect(validateToolSpec({ ...ok, description: "  " }).join()).toMatch(/description/);
  });
});

describe("validateInputForm", () => {
  it("合法表单通过", () => {
    expect(
      validateInputForm(
        form([
          { key: "c", label: "C", schema: { type: "string", enum: ["a", "b"] }, multiSelect: true },
          { key: "n", label: "N", schema: { type: "integer", minimum: 1, maximum: 3 } },
        ]),
      ),
    ).toEqual([]);
  });
  it("拒绝非子集 schema 与重复键", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 构造非子集 schema
    const arr = { type: "array", items: { type: "string" } } as any;
    // biome-ignore lint/suspicious/noExplicitAny: 构造带未知关键字的 schema
    const pat = { type: "string", pattern: "x" } as any;
    const probs = validateInputForm(
      form([
        { key: "a", label: "A", schema: arr },
        { key: "b", label: "B", schema: pat },
        { key: "b", label: "B2", schema: { type: "boolean" } },
      ]),
    ).join("\n");
    expect(probs).toMatch(/unsupported schema type "array"/);
    expect(probs).toMatch(/unsupported schema keyword "pattern"/);
    expect(probs).toMatch(/duplicate key/);
  });
  it("multiSelect / allowOther 只能用于枚举", () => {
    const p = validateInputForm(
      form([{ key: "a", label: "A", schema: { type: "boolean" }, multiSelect: true }]),
    );
    expect(p.join()).toMatch(/string enum/);
  });
});

describe("validateAnswer", () => {
  const f = form([
    { key: "pick", label: "P", schema: { type: "string", enum: ["a", "b"] }, required: true },
    { key: "many", label: "M", schema: { type: "string", enum: ["x", "y"] }, multiSelect: true },
    { key: "free", label: "F", schema: { type: "string", enum: ["u"] }, allowOther: true },
    { key: "n", label: "N", schema: { type: "number", minimum: 0, maximum: 5 } },
  ]);
  it("合法答案通过", () => {
    expect(validateAnswer(f, { pick: "a", many: ["x", "y"], free: "anything", n: 3 })).toEqual([]);
  });
  it("必填缺失", () => {
    expect(validateAnswer(f, {}).join()).toMatch(/"pick": is required/);
  });
  it("多选越界与单选越界", () => {
    expect(validateAnswer(f, { pick: "z", many: ["x", "q"] }).join("\n")).toMatch(
      /"pick".*one of[\s\S]*"many".*one of/,
    );
  });
  it("allowOther 接受枚举外文本，但不接受空串；数值范围仍校验", () => {
    expect(validateAnswer(f, { pick: "a", free: "" }).join()).toMatch(/"free"/);
    expect(validateAnswer(f, { pick: "a", n: 9 }).join()).toMatch(/<= 5/);
  });
  it("未知字段被报告", () => {
    expect(validateAnswer(f, { pick: "a", zzz: true }).join()).toMatch(/unknown field "zzz"/);
  });
});
