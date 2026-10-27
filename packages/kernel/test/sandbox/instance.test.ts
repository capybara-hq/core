import { describe, expect, it } from "vitest";
import { isInstance } from "../../src/sandbox/sandbox.service.js";

/** Rebuild detection compares handles independent of key order (final review m9). */
describe("isInstance", () => {
  const at = new Date("2026-10-27T10:00:00Z");
  const row = (handle: { id: string; [k: string]: unknown } | null) => ({
    handle,
    created_at: at,
  });

  it("matches a handle whose keys came back from jsonb in another order", () => {
    const gone = {
      handle: { id: "i-1", region: "eu", meta: { b: 2, a: 1 } },
      createdAt: at.getTime(),
    };
    expect(isInstance(row({ region: "eu", meta: { a: 1, b: 2 }, id: "i-1" }), gone)).toBe(true);
  });

  it("does not match another handle, another created_at, or no instance", () => {
    const gone = { handle: { id: "i-1" }, createdAt: at.getTime() };
    expect(isInstance(row({ id: "i-2" }), gone)).toBe(false);
    expect(
      isInstance({ handle: { id: "i-1" }, created_at: new Date(at.getTime() + 1) }, gone),
    ).toBe(false);
    expect(isInstance(row(null), gone)).toBe(false);
    expect(isInstance(row({ id: "i-1" }), null)).toBe(false);
  });
});
