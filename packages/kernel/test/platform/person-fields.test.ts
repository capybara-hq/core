import { configJsonSchema, secret, ui } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkPersonValue,
  PERSON_FIELD_MAX_BYTES,
  type PersonFieldSpec,
  type PersonFieldTarget,
  personFieldParams,
  planPersonFields,
  secretFieldsOf,
} from "../../src/platform/person-fields.js";

/**
 * The person field rules (platform web parity spec §4.1, §4.2): which secret fields of a target's
 * config schema the person types on the approval card, the plan for one call's params, and the
 * check of one typed value. Pure functions; no database, no app.
 */

const schema = configJsonSchema(
  z.object({
    baseUrl: z.string(),
    apiKey: secret(z.string()),
    nested: z.object({ token: secret(z.string()).optional() }),
  }),
);

const target = (stored: string[] = []): PersonFieldTarget => {
  const { fields, recordOnly } = secretFieldsOf(schema, new Set(stored));
  return { target: { zh: "测试", en: "Test" }, fields, recordOnly };
};

const SECRET_IN_VALUES =
  "Secret fields are entered by the person on the confirmation card; leave `apiKey` out of values and list it in askPerson. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it.";

describe("secretFieldsOf", () => {
  it("finds the secret leaves by dot path, with required along the whole path", () => {
    const { fields, recordOnly } = secretFieldsOf(schema, new Set());
    expect(fields.map((f) => f.path)).toEqual(["apiKey", "nested.token"]);
    expect(fields.map((f) => f.required)).toEqual([true, false]);
    expect(fields.map((f) => f.isSet)).toEqual([false, false]);
    expect(recordOnly).toEqual([]);
  });

  it("an optional parent makes a listed leaf not required", () => {
    const s = configJsonSchema(
      z.object({ auth: z.object({ token: secret(z.string()) }).optional() }),
    );
    const { fields } = secretFieldsOf(s, new Set());
    expect(fields.map((f) => [f.path, f.required])).toEqual([["auth.token", false]]);
  });

  it("isSet comes from the stored set", () => {
    const { fields } = secretFieldsOf(schema, new Set(["apiKey"]));
    expect(fields.map((f) => f.isSet)).toEqual([true, false]);
  });

  it("puts secret records under x-ui.secrets into recordOnly, not fields", () => {
    const s = configJsonSchema(
      z.object({
        endpoints: ui(z.array(z.object({ name: z.string() })), {
          secrets: [{ path: "endpointKeys", keyBy: "name", label: { zh: "密钥", en: "Key" } }],
        }),
        endpointKeys: secret(z.record(z.string(), z.string())).optional(),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    expect(fields).toEqual([]);
    expect(recordOnly).toEqual(["endpointKeys"]);
  });

  it("takes the label and description from the schema node and scrubs value keywords", () => {
    const s = configJsonSchema(
      z.object({
        apiKey: ui(secret(z.string().min(10).default("dont-publish")), {
          label: { zh: "接口密钥", en: "API key" },
          help: { zh: "在控制台创建", en: "Create one in the console" },
        }),
      }),
    );
    const [f] = secretFieldsOf(s, new Set()).fields;
    expect(f?.label).toBe("API key");
    expect(f?.description).toBe("Create one in the console");
    expect(f?.multiline).toBe(false);
    expect(JSON.stringify(f?.schema)).not.toContain("dont-publish");
    expect(f?.schema).not.toHaveProperty("default");
    expect(f?.schema).toMatchObject({ type: "string", minLength: 10 });
  });

  it("falls back to the path as the label and marks a textarea widget multiline", () => {
    const fields = secretFieldsOf(
      {
        type: "object",
        properties: {
          key: { type: "string", "x-secret": true, "x-ui": { widget: "textarea" } },
        },
      },
      new Set(),
    ).fields;
    expect(fields).toMatchObject([{ path: "key", label: "key", multiline: true }]);
  });

  it("returns nothing for a value that is not a JSON Schema object", () => {
    expect(secretFieldsOf(null, new Set())).toEqual({ fields: [], recordOnly: [] });
  });
});

describe("planPersonFields", () => {
  it("refuses a secret in values with the exact copy and no part of the value", () => {
    const value = "sk-live-abcdef123456";
    const r = planPersonFields(target(), {
      values: { baseUrl: "https://x", apiKey: value },
      askPerson: [],
      clearSecrets: [],
    });
    expect(r).toEqual({ ok: false, message: SECRET_IN_VALUES });
    if (!r.ok) expect(r.message).not.toContain("sk-live");
  });

  it("refuses an ask for a field that is not a secret of the target", () => {
    expect(planPersonFields(target(), { askPerson: ["baseUrl"], clearSecrets: [] })).toEqual({
      ok: false,
      message:
        "baseUrl is not a secret field of this target; only these can be asked: apiKey, nested.token",
    });
  });

  it("adds a required unset secret to ask when not named, never a set one", () => {
    const unset = planPersonFields(target(), { askPerson: [], clearSecrets: [] });
    expect(unset.ok && unset.ask.map((f) => f.path)).toEqual(["apiKey"]);
    const set = planPersonFields(target(["apiKey"]), { askPerson: [], clearSecrets: [] });
    expect(set).toEqual({ ok: true, ask: [], clear: [] });
  });

  it("keeps the named asks and clears", () => {
    const r = planPersonFields(target(["apiKey"]), {
      askPerson: ["apiKey"],
      clearSecrets: ["nested.token"],
    });
    expect(r.ok && r.ask.map((f) => f.path)).toEqual(["apiKey"]);
    expect(r.ok && r.clear).toEqual(["nested.token"]);
  });

  it("refuses a path both asked and cleared", () => {
    const r = planPersonFields(target(), { askPerson: ["apiKey"], clearSecrets: ["apiKey"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("apiKey");
  });

  it("refuses clearing a field that is not a secret of the target", () => {
    const r = planPersonFields(target(), { askPerson: [], clearSecrets: ["baseUrl"] });
    expect(r.ok).toBe(false);
  });

  it("refuses more than 32 asks", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) props[`k${i}`] = { type: "string", "x-secret": true };
    const { fields } = secretFieldsOf({ type: "object", properties: props }, new Set());
    const r = planPersonFields(
      { target: { zh: "多", en: "Many" }, fields },
      { askPerson: fields.map((f) => f.path), clearSecrets: [] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("32");
  });

  it("the params schema defaults to empty arrays and caps the lists", () => {
    expect(personFieldParams.askPerson.parse(undefined)).toEqual([]);
    expect(personFieldParams.clearSecrets.parse(undefined)).toEqual([]);
    expect(personFieldParams.askPerson.safeParse(Array(33).fill("a")).success).toBe(false);
    expect(personFieldParams.askPerson.safeParse(["a".repeat(201)]).success).toBe(false);
  });
});

describe("checkPersonValue", () => {
  const spec = (node: Record<string, unknown>): PersonFieldSpec => ({
    path: "apiKey",
    label: "apiKey",
    multiline: false,
    required: true,
    isSet: false,
    schema: node,
  });

  it("refuses a value over 16 KiB in UTF-8 bytes", () => {
    // 3 bytes per character: under the limit in characters, over it in bytes.
    const value = "密".repeat(Math.floor(PERSON_FIELD_MAX_BYTES / 3) + 1);
    expect(value.length).toBeLessThan(PERSON_FIELD_MAX_BYTES);
    expect(checkPersonValue(spec({ type: "string" }), value)).toContain("16 KiB");
  });

  it("refuses a value failing minLength or pattern, without echoing it", () => {
    const s = spec({ type: "string", minLength: 8, pattern: "^sk-" });
    const short = checkPersonValue(s, "sk-1");
    expect(short).not.toBeNull();
    expect(short).not.toContain("sk-1");
    expect(checkPersonValue(s, "pk-12345678")).not.toBeNull();
  });

  it("accepts a valid value", () => {
    expect(
      checkPersonValue(spec({ type: "string", minLength: 8, pattern: "^sk-" }), "sk-12345678"),
    ).toBeNull();
  });
});
