import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWebUi } from "../src/web-ui.js";

const run = (name: string) => {
  const dir = fileURLToPath(new URL(`../fixtures/web-shell-access/${name}`, import.meta.url));
  return checkWebUi(join(dir, "apps/web/src"), join(dir, "packages/design/src")).filter(
    (f) => f.rule === "web-shell-access",
  );
};

describe("web-shell-access", () => {
  it("reads outside the two allowed files fail; the allowed files and tests pass", () => {
    const f = run("violation");
    expect(f.map((x) => [x.file.split("/").pop(), x.line])).toEqual([
      ["view.tsx", 2],
      ["view.tsx", 3],
    ]);
  });

  it("the allowed files alone are clean", () => {
    expect(run("ok")).toEqual([]);
  });
});
