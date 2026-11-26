import { describe, expect, it } from "vitest";
import { parsePartialJson } from "../src/lib/partial-json";

// Recorded tool inputs, written out as the model streams them.
const WRITE_INPUT =
  '{"file_path":"/work/notes.md","content":"# 标题\\nline \\"quoted\\" and a \\\\ backslash\\n\\t中文内容 😀 done\\u00e9 \\ud83d\\ude00\\n"}';
const EDIT_INPUT =
  '{"file_path":"/work/src/a.ts","old_string":"const a = 1;\\nconst b = \\"x\\";","new_string":"const a = 2;\\n","replace_all":false}';
const CONNECTOR_INPUT =
  '{"query":{"filters":[{"field":"status","in":["open","blocked"]},{"field":"n","gte":-1.5e2}],"page":{"size":20,"cursor":null}},"fields":["id",["a","b"]],"dry":true,"note":"ok"}';

describe("parsePartialJson", () => {
  for (const [name, input] of [
    ["Write", WRITE_INPUT],
    ["Edit", EDIT_INPUT],
    ["connector call", CONNECTOR_INPUT],
  ] as const) {
    it(`parses every prefix of a ${name} input and the full text equals JSON.parse`, () => {
      for (let i = 0; i <= input.length; i++) {
        const r = parsePartialJson(input.slice(0, i));
        if (i > 0) expect(r.value === null || typeof r.value === "object").toBe(true);
        if (r.value) {
          const full = JSON.parse(input) as Record<string, unknown>;
          for (const [k, v] of Object.entries(r.value)) {
            if (typeof v !== "string") continue;
            expect(v).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
            expect((full[k] as string).startsWith(v)).toBe(true);
          }
        }
      }
      expect(parsePartialJson(input)).toEqual({ value: JSON.parse(input), open: null });
    });
  }

  it("keeps the text of an open string and names the property", () => {
    expect(parsePartialJson('{"file_path":"/a","content":"x\\')).toEqual({
      value: { file_path: "/a", content: "x" },
      open: "content",
    });
    expect(parsePartialJson('{"file_path":"/a","content":"x\\n').value?.content).toBe("x\n");
  });

  it("has no open property once the string closed or for non-string values", () => {
    expect(parsePartialJson('{"a":"x"').open).toBeNull();
    expect(parsePartialJson('{"a":[1,"x').open).toBeNull();
    expect(parsePartialJson('{"a":{"b":"x').open).toBeNull();
  });

  it("drops a dangling key, a missing value and half-written literals or numbers", () => {
    expect(parsePartialJson('{"a":1,"b').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":tru').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":-').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"b":1e').value).toEqual({ a: 1, b: 1 });
  });

  it("drops half of a surrogate pair, raw or escaped", () => {
    const emoji = "😀";
    expect(parsePartialJson(`{"a":"x${emoji.slice(0, 1)}`).value).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x\\ud83d').value).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x\\ud83d\\ude').value).toEqual({ a: "x" });
    expect(parsePartialJson(`{"a":"x${emoji}`).value).toEqual({ a: `x${emoji}` });
  });

  it("returns null before an object starts and never throws on malformed text", () => {
    expect(parsePartialJson("")).toEqual({ value: null, open: null });
    expect(parsePartialJson("  ")).toEqual({ value: null, open: null });
    expect(parsePartialJson("[1,2")).toEqual({ value: null, open: null });
    expect(parsePartialJson('{"a":1,}').value).toEqual({ a: 1 });
    expect(() => parsePartialJson('{"a":@,"b":"c"}')).not.toThrow();
  });

  it("keeps the last complete numeric prefix of a number cut mid-token", () => {
    expect(parsePartialJson('{"a":1.').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1e').value).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":-1.5e+').value).toEqual({ a: -1.5 });
    expect(parsePartialJson('{"a":-').value).toEqual({});
  });

  it("keeps a __proto__ key as an own property like JSON.parse", () => {
    const r = parsePartialJson('{"__proto__":{"x":1},"a":1}');
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(Object.keys(r.value ?? {})).toEqual(["__proto__", "a"]);
    expect(r.value).toEqual(JSON.parse('{"__proto__":{"x":1},"a":1}'));
  });

  it("does not throw on very deep nesting and drops containers past the depth limit", () => {
    expect(() => parsePartialJson(`{"a":${"[".repeat(20000)}`)).not.toThrow();
    const depthOf = (v: unknown): number =>
      Array.isArray(v) || (v && typeof v === "object")
        ? 1 + Math.max(0, ...Object.values(v as object).map(depthOf))
        : 0;
    const r = parsePartialJson(`{"a":1,"b":${"[".repeat(20000)}`);
    expect(r.value?.a).toBe(1);
    expect(depthOf(r.value)).toBeLessThanOrEqual(64);
    expect(depthOf(parsePartialJson(`{"a":${'{"k":'.repeat(20000)}`).value)).toBeLessThanOrEqual(
      64,
    );
  });
});
