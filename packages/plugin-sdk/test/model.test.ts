import { describe, expect, it } from "vitest";
import {
  assertValidDeclarations,
  isModelError,
  isRetryableKind,
  MODEL_PROVIDER_CAPABILITY,
  MODEL_PROVIDER_CAPABILITY_V2,
  ModelError,
  type ModelErrorKind,
  type ModelParameter,
  sanitizeParams,
  validateParams,
} from "../src/index.js";

describe("isModelError / isRetryableKind", () => {
  it("duck-types a lookalike from another class", () => {
    class Other extends Error {
      kind = "aborted";
    }
    expect(isModelError(new Other("x"))).toBe(true);
    expect(isModelError(new ModelError("auth", "x"))).toBe(true);
  });
  it("rejects plain errors and non-errors", () => {
    expect(isModelError(new Error("x"))).toBe(false);
    expect(isModelError({ kind: "aborted" })).toBe(false);
    class Bad extends Error {
      kind = "nope";
    }
    expect(isModelError(new Bad("x"))).toBe(false);
  });
  it("isRetryableKind table", () => {
    for (const k of ["rate_limited", "overloaded", "server", "timeout", "network"] as const)
      expect(isRetryableKind(k)).toBe(true);
    for (const k of ["auth", "invalid_request", "context_overflow", "aborted"] as const)
      expect(isRetryableKind(k)).toBe(false);
  });
});

describe("ModelError", () => {
  it.each<[ModelErrorKind, boolean]>([
    ["rate_limited", true],
    ["overloaded", true],
    ["server", true],
    ["timeout", true],
    ["network", true],
    ["auth", false],
    ["invalid_request", false],
    ["context_overflow", false],
    ["aborted", false],
  ])("%s retryable=%s", (kind, retryable) => {
    expect(new ModelError(kind, "x").retryable).toBe(retryable);
  });
  it("keeps kind, retryAfterMs and cause", () => {
    const cause = new Error("c");
    const e = new ModelError("rate_limited", "slow", { retryAfterMs: 1500, cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(1500);
    expect(e.cause).toBe(cause);
  });
});

describe("model-provider capability", () => {
  it("constant", () => {
    expect(MODEL_PROVIDER_CAPABILITY).toBe("model-provider@1");
    expect(MODEL_PROVIDER_CAPABILITY_V2).toBe("model-provider@2");
  });
});

const L = (en: string) => ({ zh: en, en });
const DECL: ModelParameter[] = [
  {
    key: "effort",
    standard: "effort",
    schema: { type: "string", enum: ["low", "medium", "high"] },
    default: "medium",
    label: L("Effort"),
  },
  {
    key: "temperature",
    standard: "temperature",
    schema: { type: "number", minimum: 0, maximum: 2 },
    label: L("Temperature"),
  },
  {
    key: "maxOutputTokens",
    standard: "maxOutputTokens",
    schema: { type: "integer", minimum: 1, maximum: 4096 },
    label: L("Max output tokens"),
  },
  { key: "p.search", schema: { type: "boolean" }, default: false, label: L("Search") },
  { key: "p.tag", schema: { type: "string", maxLength: 5 }, label: L("Tag") },
];

describe("validateParams", () => {
  it.each<[string, Record<string, unknown>, Record<string, string | number | boolean>]>([
    ["empty", {}, {}],
    [
      "all valid",
      {
        effort: "high",
        temperature: 0.5,
        maxOutputTokens: 100,
        "p.search": true,
        "p.tag": "abcde",
      },
      {
        effort: "high",
        temperature: 0.5,
        maxOutputTokens: 100,
        "p.search": true,
        "p.tag": "abcde",
      },
    ],
    ["integer accepted by number", { temperature: 1 }, { temperature: 1 }],
    [
      "bounds inclusive",
      { temperature: 0, maxOutputTokens: 4096 },
      { temperature: 0, maxOutputTokens: 4096 },
    ],
    ["undefined treated as absent", { effort: undefined }, {}],
  ])("ok: %s", (_name, params, value) => {
    expect(validateParams(DECL, params)).toEqual({ ok: true, value });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["enum out of range", { effort: "max" }, "effort"],
    ["enum wrong type", { effort: 1 }, "effort"],
    ["number wrong type", { temperature: "0.5" }, "temperature"],
    ["number above maximum", { temperature: 2.5 }, "temperature"],
    ["number below minimum", { temperature: -1 }, "temperature"],
    ["number not finite", { temperature: Number.NaN }, "temperature"],
    ["integer with fraction", { maxOutputTokens: 1.5 }, "maxOutputTokens"],
    ["integer below minimum", { maxOutputTokens: 0 }, "maxOutputTokens"],
    ["boolean wrong type", { "p.search": "true" }, "p.search"],
    ["string too long", { "p.tag": "abcdef" }, "p.tag"],
    ["string wrong type", { "p.tag": 5 }, "p.tag"],
    ["unknown key", { "p.nope": 1 }, "p.nope"],
    ["prototype key", { __proto__: 1, constructor: "x" } as Record<string, unknown>, "constructor"],
  ])("rejects: %s", (_name, params, key) => {
    const r = validateParams(DECL, params);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.key)).toContain(key);
    for (const i of r.issues) expect(i.message).toMatch(/^[\x20-\x7e]+$/);
  });

  it("reports every invalid key", () => {
    const r = validateParams(DECL, {
      effort: "max",
      temperature: 9,
      "p.nope": 1,
      "p.search": true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.map((i) => i.key).sort()).toEqual(["effort", "p.nope", "temperature"]);
  });

  it("is pure (does not fill defaults or mutate input)", () => {
    const input = { temperature: 1 };
    const r = validateParams(DECL, input);
    expect(r).toEqual({ ok: true, value: { temperature: 1 } });
    expect(input).toEqual({ temperature: 1 });
  });
});

describe("sanitizeParams", () => {
  it.each<[string, Record<string, unknown>, Record<string, string | number | boolean>, string[]]>([
    ["fills defaults", {}, { effort: "medium", "p.search": false }, []],
    [
      "keeps valid values",
      { effort: "low", temperature: 1, "p.search": true },
      { effort: "low", temperature: 1, "p.search": true },
      [],
    ],
    [
      "drops enum out of range and uses default",
      { effort: "max" },
      { effort: "medium", "p.search": false },
      ["effort"],
    ],
    [
      "drops wrong type without default",
      { temperature: "hot" },
      { effort: "medium", "p.search": false },
      ["temperature"],
    ],
    [
      "drops unknown key",
      { "p.nope": 1, maxOutputTokens: 10 },
      { effort: "medium", "p.search": false, maxOutputTokens: 10 },
      ["p.nope"],
    ],
    [
      "drops out of range number",
      { maxOutputTokens: 99999 },
      { effort: "medium", "p.search": false },
      ["maxOutputTokens"],
    ],
  ])("%s", (_name, params, value, dropped) => {
    expect(sanitizeParams(DECL, params)).toEqual({ value, dropped });
  });

  it("empty declarations drop everything", () => {
    expect(sanitizeParams([], { effort: "high" })).toEqual({ value: {}, dropped: ["effort"] });
  });
});

describe("assertValidDeclarations", () => {
  const ok = (): ModelParameter[] => structuredClone(DECL);
  it("accepts valid declarations (standard knobs and prefixed vendor params)", () => {
    expect(() => assertValidDeclarations("p", ok())).not.toThrow();
    expect(() => assertValidDeclarations("p", [])).not.toThrow();
  });

  it.each<[string, ModelParameter[], RegExp]>([
    [
      "vendor key without prefix",
      [{ key: "foo", schema: { type: "boolean" }, label: L("Foo") }],
      /foo/,
    ],
    [
      "vendor key with another plugin's prefix",
      [{ key: "q.foo", schema: { type: "boolean" }, label: L("Foo") }],
      /q\.foo/,
    ],
    [
      "vendor key with empty name",
      [{ key: "p.", schema: { type: "boolean" }, label: L("Foo") }],
      /p\./,
    ],
    [
      "standard effort on prefixed key",
      [
        {
          key: "x.effort",
          standard: "effort",
          schema: { type: "string", enum: ["low"] },
          label: L("E"),
        },
      ],
      /x\.effort/,
    ],
    [
      "standard key without standard",
      [{ key: "temperature", schema: { type: "number" }, label: L("T") }],
      /temperature/,
    ],
    [
      "standard mismatching key",
      [{ key: "temperature", standard: "effort", schema: { type: "number" }, label: L("T") }],
      /temperature/,
    ],
    [
      "duplicate key",
      [
        { key: "p.a", schema: { type: "boolean" }, label: L("A") },
        { key: "p.a", schema: { type: "boolean" }, label: L("A") },
      ],
      /duplicate/,
    ],
    [
      "effort value outside the standard set",
      [
        {
          key: "effort",
          standard: "effort",
          schema: { type: "string", enum: ["low", "turbo"] },
          label: L("E"),
        },
      ],
      /effort/,
    ],
    [
      "effort not an enum",
      [{ key: "effort", standard: "effort", schema: { type: "boolean" }, label: L("E") }],
      /effort/,
    ],
    [
      "thinking value outside the standard set",
      [
        {
          key: "thinking",
          standard: "thinking",
          schema: { type: "string", enum: ["adaptive"] },
          label: L("T"),
        },
      ],
      /thinking/,
    ],
    [
      "temperature not a number",
      [{ key: "temperature", standard: "temperature", schema: { type: "integer" }, label: L("T") }],
      /temperature/,
    ],
    [
      "maxOutputTokens not an integer",
      [
        {
          key: "maxOutputTokens",
          standard: "maxOutputTokens",
          schema: { type: "number" },
          label: L("M"),
        },
      ],
      /maxOutputTokens/,
    ],
    ["empty enum", [{ key: "p.a", schema: { type: "string", enum: [] }, label: L("A") }], /p\.a/],
    [
      "unsupported schema type",
      [
        {
          key: "p.a",
          schema: { type: "object" } as unknown as ModelParameter["schema"],
          label: L("A"),
        },
      ],
      /p\.a/,
    ],
    [
      "minimum above maximum",
      [{ key: "p.a", schema: { type: "number", minimum: 2, maximum: 1 }, label: L("A") }],
      /p\.a/,
    ],
    [
      "invalid default",
      [{ key: "p.a", schema: { type: "boolean" }, default: "yes", label: L("A") }],
      /p\.a/,
    ],
    [
      "missing label",
      [{ key: "p.a", schema: { type: "boolean" }, label: { zh: "", en: "A" } }],
      /p\.a/,
    ],
  ])("rejects: %s", (_name, decl, msg) => {
    expect(() => assertValidDeclarations("p", decl)).toThrow(msg);
  });

  it("rejects a non-array declaration", () => {
    expect(() => assertValidDeclarations("p", undefined as unknown as ModelParameter[])).toThrow(
      /parameters/,
    );
  });
});
