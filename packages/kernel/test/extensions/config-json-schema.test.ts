import { secret, ui } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configFormSchema,
  configToJsonSchema,
  stripConfigUi,
} from "../../src/extensions/config-json-schema.js";

// The conversion itself (scrub, unsupported types, hint copies) is the SDK's and tested there
// (packages/plugin-sdk/test/config-ui.test.ts); these cases cover what the kernel adds.

type Props = { properties: Record<string, Record<string, unknown>> };
const label = (en: string) => ({ zh: en, en });

describe("configToJsonSchema (the SDK's configJsonSchema)", () => {
  it("passes x-ui, x-hot and x-secret through", () => {
    const js = configToJsonSchema(
      z.object({
        greeting: ui(z.string().default("hi").meta({ hot: true }), { label: label("Greeting") }),
        token: secret(z.string()).optional(),
      }),
    ) as unknown as Props;
    expect(js.properties.greeting).toMatchObject({
      "x-hot": true,
      "x-ui": { label: label("Greeting") },
    });
    expect(js.properties.token?.["x-secret"]).toBe(true);
  });
});

describe("configFormSchema", () => {
  const good = z.object({
    mode: ui(z.enum(["a", "b"]).default("a"), {
      options: [{ value: "a", label: label("A") }],
    }),
  });
  const bad = z.object({
    mode: ui(z.enum(["a", "b"]).default("a"), {
      options: [{ value: "c", label: label("C") }],
    }),
    nested: z.object({ n: ui(z.number().default(1), { unit: label("ms") }) }),
  });

  it("valid hints stay, with no problems", () => {
    const r = configFormSchema(good, "deployment");
    expect(r.problems).toEqual([]);
    expect((r.schema as unknown as Props).properties.mode?.["x-ui"]).toBeDefined();
  });

  it("invalid hints: every x-ui is stripped and the problems are reported", () => {
    const r = configFormSchema(bad, "org");
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems[0]?.path).toBe("mode");
    expect(JSON.stringify(r.schema)).not.toContain("x-ui");
    // the rest of the schema is untouched
    expect((r.schema as unknown as Props).properties.mode?.enum).toEqual(["a", "b"]);
  });

  it("is cached per schema object and level", () => {
    expect(configFormSchema(good, "deployment")).toBe(configFormSchema(good, "deployment"));
    // record secrets are allowed only at the deployment level
    const rec = z.object({
      keys: secret(z.record(z.string(), z.string())).default({}),
      list: ui(z.array(z.object({ name: z.string() })).default([]), {
        secrets: [{ path: "keys", keyBy: "name", label: label("Key") }],
      }),
    });
    expect(configFormSchema(rec, "deployment").problems).toEqual([]);
    expect(configFormSchema(rec, "connection").problems.length).toBeGreaterThan(0);
  });

  it("stripConfigUi leaves values alone: default, const, enum and examples keep their x-ui keys", () => {
    const value = { "x-ui": 1, nested: { "x-ui": 2 } };
    const js = {
      type: "object",
      "x-ui": { label: label("Root") },
      default: structuredClone(value),
      const: structuredClone(value),
      enum: [structuredClone(value)],
      examples: [structuredClone(value)],
      properties: {
        a: { type: "object", default: structuredClone(value), "x-ui": { label: label("A") } },
      },
    };
    stripConfigUi(js);
    expect(js).toEqual({
      type: "object",
      default: value,
      const: value,
      enum: [value],
      examples: [value],
      properties: { a: { type: "object", default: value } },
    });
  });

  it("stripConfigUi leaves a property named x-ui alone", () => {
    const js = {
      type: "object",
      "x-ui": { label: label("Root") },
      properties: {
        "x-ui": { type: "string", "x-ui": { label: label("Field") } },
        list: { type: "array", items: { type: "string", "x-ui": { label: label("Item") } } },
      },
    };
    stripConfigUi(js);
    expect(js).toEqual({
      type: "object",
      properties: {
        "x-ui": { type: "string" },
        list: { type: "array", items: { type: "string" } },
      },
    });
  });
});
