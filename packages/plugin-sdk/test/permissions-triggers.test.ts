import { describe, expect, it } from "vitest";
import { validatePermissions } from "../src/index.js";

const check = (triggers: unknown) => validatePermissions("tasks", { triggers });

describe("permissions.triggers", () => {
  it("accepts dotted lower-case event types", () => {
    expect(check({ emit: ["item.created", "item.status_changed"] })).toEqual([]);
  });
  it("refuses bad type names, duplicates, extra keys and too many types", () => {
    expect(check({ emit: ["Item:Created"] })).not.toEqual([]);
    expect(check({ emit: ["a", "a"] })).not.toEqual([]);
    expect(check({ emit: ["a"], other: 1 })).not.toEqual([]);
    expect(check({ emit: Array.from({ length: 65 }, (_, i) => `t${i}`) })).not.toEqual([]);
    expect(check("x")).not.toEqual([]);
  });
});
