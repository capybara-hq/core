import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const list = (name: string): string[] =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as string[];

describe("test portfolio lists", () => {
  it("lists unit and container tests with no overlap", () => {
    const unit = new Set(list("unit-tests.json"));
    const overlap = list("container-tests.json").filter((p) => unit.has(p));
    expect(overlap).toEqual([]);
  });

  it("lists only files that exist", () => {
    for (const p of [...list("unit-tests.json"), ...list("container-tests.json")]) {
      expect(() => readFileSync(new URL(`./${p}`, import.meta.url))).not.toThrow();
    }
  });
});
