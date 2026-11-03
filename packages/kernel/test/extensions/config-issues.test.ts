import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toIssues } from "../../src/extensions/config-issues.js";

const messages = { duplicateEndpoint: { zh: "端点名重复", en: "Duplicate endpoint name" } };

describe("toIssues", () => {
  const schema = z
    .object({ endpoints: z.array(z.string()) })
    .refine((v) => new Set(v.endpoints).size === v.endpoints.length, {
      message: "duplicate secret-value-in-message",
      params: { ui: "duplicateEndpoint" },
    });

  it("a custom issue whose params.ui names a root message gets messageKey", () => {
    const r = schema.safeParse({ endpoints: ["a", "a"] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issues = toIssues(r.error, messages);
    expect(issues).toEqual([
      { path: "", segments: [], message: "invalid value", messageKey: "duplicateEndpoint" },
    ]);
    // zod's custom text (it may contain values) is never used
    expect(JSON.stringify(issues)).not.toContain("secret-value");
  });

  it("no messageKey when the key is not in the messages (or there are none)", () => {
    const r = schema.safeParse({ endpoints: ["a", "a"] });
    if (r.success) throw new Error("expected a failure");
    expect(toIssues(r.error, { other: messages.duplicateEndpoint })[0]).not.toHaveProperty(
      "messageKey",
    );
    expect(toIssues(r.error)[0]).not.toHaveProperty("messageKey");
    // an inherited name is no message
    expect(toIssues(r.error, {})[0]).not.toHaveProperty("messageKey");
  });

  it("segments keep the unjoined path (record keys may contain dots)", () => {
    const r = z
      .object({ apiKeys: z.record(z.string(), z.string()), list: z.array(z.number()) })
      .safeParse({ apiKeys: { "a.b": 1 }, list: [1, "x"] });
    if (r.success) throw new Error("expected a failure");
    expect(toIssues(r.error)).toEqual([
      { path: "apiKeys.a.b", segments: ["apiKeys", "a.b"], message: "expected string" },
      { path: "list.1", segments: ["list", 1], message: "expected number" },
    ]);
  });
});
