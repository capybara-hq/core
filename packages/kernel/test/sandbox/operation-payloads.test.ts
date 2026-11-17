import { describe, expect, it } from "vitest";
import {
  describeOperationPayload,
  operationPayloadChunks,
} from "../../src/sandbox/operation-payloads.js";

/**
 * A managed operation's retained result goes inline into jsonb only when jsonb can hold it: a NUL
 * (`find -print0`, `grep --null`) or a lone surrogate keeps it in the chunked form instead, whose
 * framing preserves every UTF-16 code unit (B-17: Glob and Grep on the managed route).
 */
describe("operation payload inline form", () => {
  it("keeps a small ordinary result inline", () => {
    const d = describeOperationPayload({ exitCode: 0, stdout: "./a.txt\n", stderr: "" });
    expect(d.inline).toBe(JSON.stringify({ exitCode: 0, stdout: "./a.txt\n", stderr: "" }));
  });

  it.each([
    ["a NUL", "./a.txt\u0000./b.txt\u0000"],
    ["a lone high surrogate", "x\ud800y"],
    ["a lone low surrogate", "x\udc00y"],
  ])("keeps a result with %s out of jsonb, in chunks", (_name, stdout) => {
    const value = { exitCode: 0, stdout, stderr: "" };
    const d = describeOperationPayload(value);
    expect(d.inline).toBeNull();
    expect(d.chunks).toBe([...operationPayloadChunks(value)].length);
  });

  it("an escaped backslash before u0000 only costs the inline form, never the value", () => {
    const d = describeOperationPayload({ stdout: "\\u0000 literally" });
    expect(d.inline === null || JSON.parse(d.inline).stdout === "\\u0000 literally").toBe(true);
  });

  it("a valid surrogate pair stays inline", () => {
    const d = describeOperationPayload({ stdout: "emoji \u{1F600}" });
    expect(d.inline).toBe(JSON.stringify({ stdout: "emoji \u{1F600}" }));
  });
});
