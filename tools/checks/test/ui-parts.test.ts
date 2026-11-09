import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_PARTS, type UiPartSpec } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { checkUiParts } from "../src/ui-parts.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/ui-parts/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("check:ui-parts", () => {
  it("a stale generated copy reports ui-parts-stale", () => {
    const findings = checkUiParts(fixture("stale"));
    expect(findings.some((f) => f.rule === "ui-parts-stale")).toBe(true);
    expect(findings.some((f) => f.file.endsWith("ui-parts.generated.ts"))).toBe(true);
  });

  it("the repo root is clean", () => {
    expect(checkUiParts(repoRoot)).toEqual([]);
  });

  it("every owner file exists in the repo", () => {
    for (const p of UI_PARTS)
      for (const o of p.owner) expect(existsSync(join(repoRoot, o)), o).toBe(true);
  });
});

describe("check:ui-parts render rules", () => {
  const part = (name: string, ...owner: string[]) => ({ name, owner }) as unknown as UiPartSpec;
  const one = [part("x.one", "packages/design/src/a.tsx")];
  const rules = (name: string, parts: readonly UiPartSpec[]) =>
    checkUiParts(fixture(name), parts).map((f) => f.rule);

  it("a catalog part no owner file renders -> ui-part-unrendered", () => {
    const two = [...one, part("x.two", "packages/design/src/a.tsx")];
    expect(rules("unrendered", two)).toEqual(["ui-part-unrendered"]);
  });
  it("a literal that is no catalog part -> ui-part-undeclared", () => {
    expect(rules("undeclared", one)).toEqual(["ui-part-undeclared"]);
  });
  it("a part rendered outside its owner files -> ui-part-owner and unrendered", () => {
    expect(rules("owner", one)).toEqual(["ui-part-owner", "ui-part-unrendered"]);
  });
  it("a computed value -> ui-part-literal (and counts nothing)", () => {
    expect(rules("dynamic", one)).toEqual(["ui-part-literal"]);
  });
  it("literal conditionals count, several tokens, dev/ is skipped, owner lists work", () => {
    const parts = [
      part("x.one", "packages/design/src/a.tsx"),
      part("x.two", "packages/design/src/a.tsx", "apps/web/src/b.tsx"),
    ];
    expect(rules("ok", parts)).toEqual([]);
  });
});
