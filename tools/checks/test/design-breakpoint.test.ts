import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWebUi } from "../src/web-ui.js";

const run = (name: string) => {
  const dir = fileURLToPath(new URL(`../fixtures/design-breakpoint/${name}`, import.meta.url));
  return checkWebUi(join(dir, "apps/web/src"), join(dir, "packages/design/src")).filter(
    (f) => f.rule === "design-breakpoint",
  );
};

const at = (name: string) =>
  run(name).map((f) => [f.file.split("/").pop(), f.line] as [string | undefined, number]);

describe("design-breakpoint", () => {
  it("a width query off the class widths and a 100vh each fail", () => {
    expect(at("violation").sort()).toEqual([
      ["old-height.css", 2],
      ["old-width.css", 1],
    ]);
  });

  it("names the number to use and the dynamic unit", () => {
    const messages = run("violation").map((f) => f.message);
    expect(messages.some((m) => m.includes("639px") && m.includes("599px"))).toBe(true);
    expect(messages.some((m) => m.includes("100dvh"))).toBe(true);
  });

  it("rejects other thresholds in lists, other units, other heights and 100vh in calc()", () => {
    expect(at("violation-more")).toEqual([
      ["more.css", 1],
      ["more.css", 6],
      ["more.css", 11],
      ["more.css", 16],
      ["more.css", 22],
    ]);
  });

  it("the class queries, 1279 / 1280, the short window and the dynamic units pass", () => {
    expect(run("ok")).toEqual([]);
  });
});
