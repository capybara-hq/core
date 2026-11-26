import { describe, expect, it } from "vitest";
import {
  CONNECTOR_EXTENSION_POINT,
  type ConversationSource,
  defineExtension,
  EXTENSION_POINT_CARDINALITY,
  type InputForm,
  TOOL_TIMEOUT_MAX_MS,
  TOOL_TIMEOUT_MIN_MS,
  ToolError,
  validateAnswer,
  validateInputForm,
  validateToolPresentation,
  validateToolSpec,
} from "../src/index.js";

const form = (fields: InputForm["fields"]): InputForm => ({ title: "Pick", fields });

describe("connector@1 能力", () => {
  it("已登记为 multi，defineExtension 接受 provides connector@1", () => {
    expect(CONNECTOR_EXTENSION_POINT).toBe("connector@1");
    expect(EXTENSION_POINT_CARDINALITY.connector).toBe("multi");
    const m = defineExtension({
      name: "demo-conn",
      version: "1.0.0",
      sdk: "^0.1.0-rc.0",
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
  it("kind 缺省为 error；可标记为 unavailable（服务不可达 / 超时 / 5xx，计入熔断）", () => {
    expect(new ToolError("x").kind).toBe("error");
    const e = new ToolError("Server returned HTTP 503.", { kind: "unavailable" });
    expect(e.kind).toBe("unavailable");
    expect(e.message).toBe("Server returned HTTP 503.");
  });
});

describe("validateToolSpec", () => {
  const ok = { name: "do_it-2", description: "Does it.", inputSchema: { type: "object" } };
  it("合法声明通过", () => expect(validateToolSpec(ok)).toEqual([]));
  it("sources: a non-empty list of known conversation sources", () => {
    expect(validateToolSpec({ ...ok, sources: ["web", "channel_dm"] })).toEqual([]);
    expect(validateToolSpec({ ...ok, sources: [] }).join()).toMatch(/sources/);
    expect(
      validateToolSpec({ ...ok, sources: ["dm"] as unknown as ConversationSource[] }).join(),
    ).toMatch(/sources/);
    expect(
      validateToolSpec({ ...ok, sources: "web" as unknown as ConversationSource[] }).join(),
    ).toMatch(/sources/);
  });
  it("timeoutMs: a whole number of milliseconds within the kernel's bounds", () => {
    expect(validateToolSpec({ ...ok, timeoutMs: 180_000 })).toEqual([]);
    expect(validateToolSpec({ ...ok, timeoutMs: TOOL_TIMEOUT_MAX_MS })).toEqual([]);
    expect(validateToolSpec({ ...ok, timeoutMs: TOOL_TIMEOUT_MIN_MS })).toEqual([]);
    for (const bad of [TOOL_TIMEOUT_MAX_MS + 1, TOOL_TIMEOUT_MIN_MS - 1, 1.5, Number.NaN, "60"])
      expect(validateToolSpec({ ...ok, timeoutMs: bad as number }).join()).toMatch(/timeoutMs/);
  });
  it("非法名称 / 空描述被报告", () => {
    expect(validateToolSpec({ ...ok, name: "bad name" }).join()).toMatch(/name/);
    expect(validateToolSpec({ ...ok, name: "a".repeat(41) }).join()).toMatch(/name/);
    expect(validateToolSpec({ ...ok, description: "  " }).join()).toMatch(/description/);
  });
});

describe("validateToolPresentation", () => {
  const inputSchema = {
    type: "object",
    properties: {
      query: { type: "string" },
      channel: { type: "string" },
      limit: { type: "integer" },
    },
  };
  const ok = { title: "Search messages", keyArgs: ["query", "channel"], inputSchema };

  it("inputView names string properties of inputSchema", () => {
    const schema = {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
        n: { type: "number" },
      },
    };
    const view = { kind: "file_write" as const, path: "file_path", content: "content" };
    expect(validateToolPresentation({ inputView: view, inputSchema: schema })).toEqual([]);
    const missing = 'inputView names "nope", which is not a string property of inputSchema';
    expect(
      validateToolPresentation({ inputView: { ...view, content: "nope" }, inputSchema: schema }),
    ).toEqual([missing]);
    expect(
      validateToolPresentation({ inputView: { ...view, content: "n" }, inputSchema: schema }),
    ).toEqual(['inputView names "n", which is not a string property of inputSchema']);
    expect(
      validateToolPresentation({
        inputView: { kind: "bogus" } as never,
        inputSchema: schema,
      }),
    ).toEqual(["inputView kind must be one of file_write, file_edit, command, text"]);
  });

  it("accepts every inputView kind and rejects a non-object one", () => {
    const str = { type: "string" };
    const schema = {
      type: "object",
      properties: { p: str, o: str, n: str, command: str, description: str, text: str },
    };
    const ok = (inputView: never) => validateToolPresentation({ inputView, inputSchema: schema });
    expect(ok({ kind: "file_edit", path: "p", old: "o", new: "n" } as never)).toEqual([]);
    expect(ok({ kind: "file_edit", path: "p", old: "o", new: "x" } as never)).toEqual([
      'inputView names "x", which is not a string property of inputSchema',
    ]);
    expect(ok({ kind: "command", command: "command" } as never)).toEqual([]);
    expect(
      ok({ kind: "command", command: "command", description: "description" } as never),
    ).toEqual([]);
    expect(ok({ kind: "command", command: "command", description: "x" } as never)).toEqual([
      'inputView names "x", which is not a string property of inputSchema',
    ]);
    expect(ok({ kind: "text", field: "text" } as never)).toEqual([]);
    expect(ok({ kind: "text", field: "x" } as never)).toEqual([
      'inputView names "x", which is not a string property of inputSchema',
    ]);
    const kinds = "inputView kind must be one of file_write, file_edit, command, text";
    for (const bad of ["text", 3, null, ["text"]]) expect(ok(bad as never)).toEqual([kinds]);
  });

  it("accepts a title and key arguments that are input properties, and neither", () => {
    expect(validateToolPresentation(ok)).toEqual([]);
    expect(validateToolPresentation({ inputSchema })).toEqual([]);
    expect(validateToolPresentation({ title: "x".repeat(80), keyArgs: [], inputSchema })).toEqual(
      [],
    );
  });

  it("rejects an empty or 81-character title", () => {
    expect(validateToolPresentation({ ...ok, title: "x".repeat(81) }).join()).toMatch(/title/);
    expect(validateToolPresentation({ ...ok, title: "  " }).join()).toMatch(/title/);
  });

  it("rejects control, bidi and invisible characters in the title and key argument names", () => {
    for (const title of [
      "Read\u202Efile",
      "a\u2066b\u2069",
      "a\u2067b",
      "a\u2068b",
      "zero\u200Bwidth",
      "a\u2060b",
      "a\u200Eb",
      "a\u200Fb",
      "a\u061Cb",
      "a\u{E0041}b",
      "\uFEFFa",
      "a\nb",
      "a\u0007b",
      "a\u0085b",
      "\u200B",
    ]) {
      expect(validateToolPresentation({ ...ok, title }).join(), JSON.stringify(title)).toMatch(
        /title/,
      );
    }
    const schema = {
      type: "object",
      properties: { "q\u202E": { type: "string" }, "a\nb": { type: "string" } },
    };
    expect(validateToolPresentation({ keyArgs: ["q\u202E"], inputSchema: schema }).join()).toMatch(
      /keyArgs/,
    );
    expect(validateToolPresentation({ keyArgs: ["a\nb"], inputSchema: schema }).join()).toMatch(
      /keyArgs/,
    );
    // Ordinary non-Latin text and inner spaces are fine.
    expect(validateToolPresentation({ ...ok, title: "发送 消息 é" })).toEqual([]);
    // ZWNJ / ZWJ are allowed (review M3)
    expect(validateToolPresentation({ ...ok, title: "می\u200Cخواهم" })).toEqual([]);
    expect(validateToolPresentation({ ...ok, title: "👨\u200D👩" })).toEqual([]);
  });

  it("rejects more than 3, duplicate, or unknown key arguments", () => {
    const four = { ...ok, keyArgs: ["query", "channel", "limit", "query"] };
    expect(validateToolPresentation(four).join()).toMatch(/keyArgs/);
    expect(validateToolPresentation({ ...ok, keyArgs: ["query", "query"] }).join()).toMatch(
      /keyArgs/,
    );
    expect(validateToolPresentation({ ...ok, keyArgs: ["nope"] }).join()).toMatch(/nope/);
    // biome-ignore lint/suspicious/noExplicitAny: a key argument that is not a string
    expect(validateToolPresentation({ ...ok, keyArgs: [1 as any] }).join()).toMatch(/keyArgs/);
  });

  it("validateToolSpec reports presentation problems too", () => {
    const spec = { name: "search", description: "Search.", inputSchema, keyArgs: ["nope"] };
    expect(validateToolSpec(spec).join()).toMatch(/keyArgs/);
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
  it("url：只接受 https / http 绝对地址，≤ 2000 字符", () => {
    const fields = [{ key: "done", label: "Done", schema: { type: "boolean" as const } }];
    expect(validateInputForm({ title: "T", url: "https://example.com/auth?x=1", fields })).toEqual(
      [],
    );
    expect(validateInputForm({ title: "T", url: "javascript:alert(1)", fields }).join()).toMatch(
      /url must be an absolute http\(s\) URL/,
    );
    expect(validateInputForm({ title: "T", url: "not a url", fields }).join()).toMatch(/url/);
    expect(
      validateInputForm({ title: "T", url: `https://e.com/${"a".repeat(2000)}`, fields }).join(),
    ).toMatch(/url/);
  });
  it("multiSelect / allowOther 只能用于枚举", () => {
    const p = validateInputForm(
      form([{ key: "a", label: "A", schema: { type: "boolean" }, multiSelect: true }]),
    );
    expect(p.join()).toMatch(/string enum/);
  });
});

describe("InputForm choices and body (buttons)", () => {
  const done = (over: Record<string, unknown> = {}) => ({
    key: "done",
    label: "Done",
    schema: { type: "boolean" as const },
    required: true,
    choices: [
      { value: true, label: { zh: "完成", en: "Done" } },
      { value: false, label: { zh: "取消", en: "Cancel" } },
    ],
    ...over,
  });

  it("a confirm form (required boolean, two labelled values) with a body is valid", () => {
    expect(
      validateInputForm({ title: "T", body: { zh: "原因", en: "Why" }, fields: [done()] }),
    ).toEqual([]);
  });

  it("a one-value required enum with one choice is valid (one button)", () => {
    expect(
      validateInputForm({
        title: "Waiting",
        fields: [
          {
            key: "end",
            label: "End",
            schema: { type: "string", enum: ["end"] },
            required: true,
            choices: [{ value: "end", label: { zh: "结束等待", en: "End wait" } }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("choices outside the rule are refused", () => {
    const probs = (f: Record<string, unknown>, extra: Record<string, unknown>[] = []) =>
      validateInputForm({ title: "T", fields: [f, ...extra] as never }).join("\n");
    expect(probs(done({ required: false }))).toMatch(/require required: true/);
    expect(probs(done(), [{ key: "x", label: "X", schema: { type: "string" } }])).toMatch(
      /single field/,
    );
    expect(probs(done({ schema: { type: "string" } }))).toMatch(/boolean or a single-choice/);
    expect(
      probs(
        done({
          schema: { type: "string", enum: ["a"] },
          multiSelect: true,
          choices: [{ value: "a", label: "A" }],
        }),
      ),
    ).toMatch(/boolean or a single-choice/);
    expect(probs(done({ choices: [{ value: "yes", label: "Y" }] }))).toMatch(/not a value/);
    expect(
      probs(
        done({
          choices: [
            { value: true, label: "A" },
            { value: true, label: "B" },
          ],
        }),
      ),
    ).toMatch(/duplicate choice value/);
    expect(probs(done({ choices: [{ value: true, label: "" }] }))).toMatch(/choice label/);
    expect(probs(done({ choices: [] }))).toMatch(/1 to 3/);
    expect(
      validateInputForm({ title: "T", body: "x".repeat(2001), fields: [done()] }).join(""),
    ).toMatch(/body must be/);
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
  it("只认答案自身的键：继承的属性（toString / constructor）不算已回答", () => {
    const g = form([
      { key: "toString", label: "T", schema: { type: "string", maxLength: 10 }, required: true },
      { key: "constructor", label: "C", schema: { type: "string", maxLength: 10 } },
    ]);
    const p = validateAnswer(g, {});
    expect(p).toEqual(['field "toString": is required']);
  });
  it("多选不接受重复项", () => {
    expect(validateAnswer(f, { pick: "a", many: ["x", "x"] }).join()).toMatch(
      /"many": duplicate value "x"/,
    );
  });
});
