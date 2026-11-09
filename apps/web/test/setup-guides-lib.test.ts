import { describe, expect, it } from "vitest";
import {
  channelSchemaFields,
  channelSchemaForMode,
  inboundModeFields,
} from "../src/components/config-form/channel";
import { beforeReference, type SetupGuideBlock } from "../src/lib/setup-guides";

// Channel inbound mode fields spec §5: the guide before save, and the fields per inbound mode.

describe("beforeReference", () => {
  const md = (text: string): SetupGuideBlock => ({ kind: "markdown", text });
  const check: SetupGuideBlock = { kind: "check", id: "x", label: "X" };

  it("cuts at the last top-level thematic break, dropping every block after it", () => {
    expect(
      beforeReference([
        md("## 1. A\n\none\n\n***\n\nnot the last"),
        check,
        md("## 4. Save\n\nsave\n\n***\n\n## Sign in"),
        check,
        md("## Updates"),
      ]),
    ).toEqual([md("## 1. A\n\none\n\n***\n\nnot the last"), check, md("## 4. Save\n\nsave")]);
  });

  it("drops a block that starts with the break; keeps a guide without one whole", () => {
    expect(beforeReference([md("a"), md("---\n\n## Ref")])).toEqual([md("a")]);
    const whole = [md("a"), check, md("- * *not a break*")];
    expect(beforeReference(whole)).toEqual(whole);
    // an indented line (inside a list item) is not a top-level break
    expect(beforeReference([md("- a\n\n    ***\n- b")])).toEqual([md("- a\n\n    ***\n- b")]);
  });
});

describe("fields per inbound mode", () => {
  const schema = {
    type: "object",
    properties: {
      appToken: { type: "string", "x-secret": true, "x-ui": { inboundModes: ["long_connection"] } },
      botToken: { type: "string", "x-secret": true },
      signingSecret: { type: "string", "x-ui": { inboundModes: ["webhook", "bogus"] } },
    },
    required: ["botToken"],
  };

  it("reads the hint (unknown modes dropped)", () => {
    expect(inboundModeFields(schema)).toEqual({
      appToken: ["long_connection"],
      signingSecret: ["webhook"],
    });
  });

  it("drops another mode's fields and requires this mode's", () => {
    const long = channelSchemaForMode(schema, "long_connection");
    expect(Object.keys(long?.properties as object)).toEqual(["appToken", "botToken"]);
    expect(long?.required).toEqual(["botToken", "appToken"]);
    const hook = channelSchemaForMode(schema, "webhook");
    expect(Object.keys(hook?.properties as object)).toEqual(["botToken", "signingSecret"]);
    expect(hook?.required).toEqual(["botToken", "signingSecret"]);
    // without the hint the schema is the same object
    const plain = { type: "object", properties: { a: { type: "string" } } };
    expect(channelSchemaForMode(plain, "webhook")).toBe(plain);
    expect(channelSchemaForMode(null, "webhook")).toBeNull();
  });

  it("picks fields, all required", () => {
    expect(channelSchemaFields(schema, ["signingSecret"])).toMatchObject({
      properties: { signingSecret: { type: "string" } },
      required: ["signingSecret"],
    });
  });
});
