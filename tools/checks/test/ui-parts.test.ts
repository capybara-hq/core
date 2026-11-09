import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_PARTS } from "@capybara-hq/plugin-sdk";
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
    for (const p of UI_PARTS) expect(existsSync(join(repoRoot, p.owner)), p.owner).toBe(true);
  });
});
