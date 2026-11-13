import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTEXT_EXTENSION_POINT,
  CONTEXT_LIMITS,
  type ContextProvider,
  type ContextRequest,
  type ContextResult,
  EXTENSION_POINTS,
} from "../src/index.js";

describe("context@1", () => {
  it("is a brokered, org-scoped multi extension point", () => {
    expect(CONTEXT_EXTENSION_POINT).toBe("context@1");
    expect(EXTENSION_POINTS.context).toMatchObject({
      majors: [1],
      cardinality: "multi",
      brokered: true,
      orgScoped: true,
    });
    expect(EXTENSION_POINTS.context?.description).toMatch(/\S/);
  });

  it("limits the provider call", () => {
    expect(CONTEXT_LIMITS).toEqual({ timeoutMs: 2000, maxBytes: 32768 });
  });

  it("types the request and the result", () => {
    expectTypeOf<ContextRequest["role"]>().toEqualTypeOf<"owner" | "admin" | "member" | "guest">();
    expectTypeOf<ContextRequest["tools"]>().toEqualTypeOf<string[]>();
    expectTypeOf<ContextRequest["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ContextResult>().toEqualTypeOf<{ text: string } | null>();
    expectTypeOf<ContextProvider["provide"]>().returns.resolves.toEqualTypeOf<ContextResult>();
  });
});
