import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isSecret, orgAccess, orgAccessOf, secret } from "../src/index.js";

describe("orgAccess", () => {
  it("reads back the level it was given", () => {
    expect(orgAccessOf(orgAccess(z.string(), "override"))).toBe("override");
    expect(orgAccessOf(orgAccess(z.string(), "readonly"))).toBe("readonly");
  });

  it("is undefined without a level", () => {
    expect(orgAccessOf(z.string())).toBeUndefined();
  });

  it("merges with other meta in either order", () => {
    const a = orgAccess(secret(z.string()), "override");
    expect(isSecret(a)).toBe(true);
    expect(orgAccessOf(a)).toBe("override");
    const b = secret(orgAccess(z.string(), "override"));
    expect(isSecret(b)).toBe(true);
    expect(orgAccessOf(b)).toBe("override");
  });
});
