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

  it("finds a nullable secret either way round", () => {
    const s = configJsonSchema(
      z.object({
        outer: secret(z.string()).nullable(),
        inner: secret(z.string().nullable()),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    expect(fields.map((f) => f.path)).toEqual(["outer", "inner"]);
    expect(recordOnly).toEqual([]);
  });

  it("puts a non-string secret and a secret inside array items into recordOnly", () => {
    const s = configJsonSchema(
      z.object({
        port: secret(z.number()),
        list: z.array(z.object({ name: z.string(), key: secret(z.string()) })),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    expect(fields).toEqual([]);
    expect(recordOnly).toEqual(["port", "list[].key"]);
  });

  it("fails closed on a union of secret-bearing branches", () => {
    const s = configJsonSchema(
      z.object({
        auth: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("token"), token: secret(z.string()) }),
          z.object({ kind: z.literal("basic"), password: secret(z.string()) }),
        ]),
        plain: z.union([z.string(), z.number()]),
      }),
    );
    expect(secretFieldsOf(s, new Set())).toEqual({ fields: [], recordOnly: ["auth"] });
  });

  it("fails closed on a $ref to a secret and on an allOf holding one", () => {
    const s = {
      type: "object",
      $defs: { key: { type: "string", "x-secret": true }, name: { type: "string" } },
      properties: {
        apiKey: { $ref: "#/$defs/key" },
        name: { $ref: "#/$defs/name" },
        both: { allOf: [{ type: "string" }, { "x-secret": true }] },
        dangling: { $ref: "#/$defs/missing" },
      },
    };
    expect(secretFieldsOf(s, new Set())).toEqual({
      fields: [],
      recordOnly: ["apiKey", "both", "dangling"],
    });
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

  it("points a null secret in values to clearSecrets", () => {
    expect(
      planPersonFields(target(["apiKey"]), {
        values: { apiKey: null },
        askPerson: [],
        clearSecrets: [],
      }),
    ).toEqual({
      ok: false,
      message: "To clear `apiKey`, leave it out of values and list it in clearSecrets.",
    });
  });

  it("refuses a secret in values given as a nested object", () => {
    const r = planPersonFields(target(), {
      values: { nested: { token: "tok-123456789" } },
      askPerson: ["apiKey"],
      clearSecrets: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("`nested.token`");
  });

  it("does not read values through the prototype chain", () => {
    const values = { nested: Object.create({ token: "tok-123456789" }) as object };
    const r = planPersonFields(target(), { values, askPerson: ["apiKey"], clearSecrets: [] });
    expect(r.ok).toBe(true);
  });

  it("refuses a recordOnly path in values", () => {
    const s = configJsonSchema(
      z.object({
        port: secret(z.number()),
        list: z.array(z.object({ name: z.string(), key: secret(z.string()) })),
        a: z.object({ list: z.array(z.object({ key: secret(z.string()) })) }),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    const t: PersonFieldTarget = { target: { zh: "测试", en: "Test" }, fields, recordOnly };
    const plan = (values: Record<string, unknown>) =>
      planPersonFields(t, { values, askPerson: [], clearSecrets: [] });
    expect(plan({ port: 8080 })).toMatchObject({ ok: false });
    if (!plan({ port: 8080 }).ok)
      expect(JSON.stringify(plan({ port: 8080 }))).not.toContain("8080");
    // Anything at the array root of an array-item secret: flat, nested and prefix keys.
    expect(plan({ list: [{ name: "x", key: "sk-123456789" }] })).toMatchObject({ ok: false });
    // A null clears the list and carries no secret.
    expect(plan({ list: null })).toEqual({ ok: true, ask: [], clear: [] });
    expect(plan({ a: { list: [{ key: "sk-123456789" }] } })).toMatchObject({ ok: false });
    expect(plan({ "a.list": [] })).toMatchObject({ ok: false });
    expect(plan({})).toEqual({ ok: true, ask: [], clear: [] });
  });

  it("a null at a recordOnly path does not mask a secret under a dotted key, in either order", () => {
    const s = configJsonSchema(
      z.object({
        auth: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("token"), token: secret(z.string()) }),
          z.object({ kind: z.literal("basic"), password: secret(z.string()) }),
        ]),
      }),
    );
    const t: PersonFieldTarget = {
      target: { zh: "测试", en: "Test" },
      ...secretFieldsOf(s, new Set()),
    };
    const plan = (values: Record<string, unknown>) =>
      planPersonFields(t, { values, askPerson: [], clearSecrets: [] });
    expect(plan({ auth: null, "auth.token": "sk-123456789" })).toMatchObject({ ok: false });
    expect(plan({ "auth.token": "sk-123456789", auth: null })).toMatchObject({ ok: false });
    expect(plan({ auth: null })).toEqual({ ok: true, ask: [], clear: [] });
  });

  it("a null at a secret field does not mask the same secret under a nested key", () => {
    const r = planPersonFields(target(), {
      values: { "nested.token": null, nested: { token: "tok-123456789" } },
      askPerson: ["apiKey"],
      clearSecrets: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("leaked");
  });

  it("refuses values for secrets under records, tuples and additionalProperties", () => {
    const s = configJsonSchema(
      z.object({
        keys: z.record(z.string(), secret(z.string())),
        pair: z.tuple([z.string(), secret(z.string())]),
        extra: z.object({ name: z.string() }).catchall(secret(z.string())),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    expect(fields).toEqual([]);
    expect(recordOnly).toEqual(["keys", "pair", "extra"]);
    const t: PersonFieldTarget = { target: { zh: "测试", en: "Test" }, fields, recordOnly };
    const plan = (values: Record<string, unknown>) =>
      planPersonFields(t, { values, askPerson: [], clearSecrets: [] });
    expect(plan({ "keys.github": "sk-123456789" })).toMatchObject({ ok: false });
    expect(plan({ pair: ["a", "sk-123456789"] })).toMatchObject({ ok: false });
    expect(plan({ extra: { name: "n", other: "sk-123456789" } })).toMatchObject({ ok: false });
  });

  it("refuses undeclared keys of a secret object that takes them, keeping its declared fields", () => {
    const s = configJsonSchema(
      z.object({
        so: secret(z.object({ a: z.string() }).catchall(z.string())),
        sp: secret(z.object({ b: z.string() })),
      }),
    );
    const { fields, recordOnly } = secretFieldsOf(s, new Set());
    expect(fields.map((f) => f.path)).toEqual(["so.a", "sp.b"]);
    expect(recordOnly).toEqual(["so"]);
    const t: PersonFieldTarget = { target: { zh: "测试", en: "Test" }, fields, recordOnly };
    const plan = (values: Record<string, unknown>) =>
      planPersonFields(t, { values, askPerson: [], clearSecrets: [] });
    const other = plan({ so: { other: "sk-123456789" } });
    expect(other).toMatchObject({ ok: false });
    expect(JSON.stringify(other)).toContain("`so` is a secret record");
    expect(JSON.stringify(other)).not.toContain("sk-123456789");
    // the declared field is still asked on the card
    expect(plan({})).toMatchObject({ ok: true, ask: [{ path: "so.a" }, { path: "sp.b" }] });
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
    for (const bad of ["__proto__", "a.constructor", "prototype.x"]) {
      expect(personFieldParams.clearSecrets.safeParse([bad]).success).toBe(false);
    }
    expect(personFieldParams.askPerson.parse(["nested.token"])).toEqual(["nested.token"]);
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

  it("accepts a value when the node does not compile, and reuses compiled validators", () => {
    expect(checkPersonValue(spec({ type: "string", pattern: "(" }), "anything")).toBeNull();
    const s = spec({ type: "string", minLength: 3 });
    expect(checkPersonValue(s, "ab")).not.toBeNull();
    expect(checkPersonValue(s, "abc")).toBeNull();
  });

  it("accepts a valid value", () => {
    expect(
      checkPersonValue(spec({ type: "string", minLength: 8, pattern: "^sk-" }), "sk-12345678"),
    ).toBeNull();
  });
});
