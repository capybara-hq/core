import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkTokens,
  contrastRatio,
  parseTokens,
  renderTokensCss,
  renderTokensTs,
} from "../src/tokens.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/tokens/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const JSON_PATH = "docs/design/tokens.json";
const CSS_PATH = "packages/design/src/styles/tokens.css";
const TS_PATH = "packages/design/src/tokens.ts";

/** Loosely typed tokens.json, for mutating fixtures. */
type Loose = {
  color: { bg: { dark: string } };
  size: { control: { dense: number } };
  shadow: { "shadow-1": { dark?: string } };
  contrast: unknown[];
};

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const copyOf = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), "capybara-tokens-"));
  tmp.push(d);
  cpSync(fixture(name), d, { recursive: true });
  return d;
};

describe("checkTokens", () => {
  it("valid fixture -> no findings", () => {
    expect(checkTokens(fixture("valid"))).toEqual([]);
  });

  it("a hand-edited tokens.css -> one tokens-stale on tokens.css", () => {
    const f = checkTokens(fixture("stale"));
    expect(f.map((x) => x.rule)).toEqual(["tokens-stale"]);
    expect(f[0]?.file).toMatch(/tokens\.css$/);
    expect(f[0]?.message).toContain("run pnpm gen:tokens");
  });

  it("a hand-edited tokens.ts -> one tokens-stale on tokens.ts", () => {
    const root = copyOf("valid");
    const ts = join(root, TS_PATH);
    writeFileSync(ts, readFileSync(ts, "utf8").replace('"bg",', '"bg",\n  "extra",'));
    const f = checkTokens(root);
    expect(f.map((x) => x.rule)).toEqual(["tokens-stale"]);
    expect(f[0]?.file).toMatch(/tokens\.ts$/);
  });

  it("a missing generated file -> tokens-stale", () => {
    const root = copyOf("valid");
    rmSync(join(root, CSS_PATH));
    expect(checkTokens(root).map((x) => x.rule)).toEqual(["tokens-stale"]);
  });

  it("a color without its light value -> one tokens-invalid naming the path", () => {
    const f = checkTokens(fixture("invalid"));
    expect(f.map((x) => x.rule)).toEqual(["tokens-invalid"]);
    expect(f[0]?.message).toContain("color.panel.light");
    expect(f[0]?.file).toMatch(/tokens\.json$/);
  });

  it("a pair below its floor -> one tokens-contrast naming pair, theme, ratio and floor", () => {
    const f = checkTokens(fixture("low-contrast"));
    expect(f.map((x) => x.rule)).toEqual(["tokens-contrast"]);
    expect(f[0]?.message).toContain("muted on bg (light)");
    expect(f[0]?.message).toContain("4.5");
  });

  it("the repository's tokens are well-formed, generated and pass contrast", () => {
    expect(checkTokens(repoRoot)).toEqual([]);
  });
});

describe("parseTokens", () => {
  const valid = readFileSync(join(fixture("valid"), JSON_PATH), "utf8");
  const mutate = (fn: (j: Loose) => void): string => {
    const j = JSON.parse(valid);
    fn(j);
    return JSON.stringify(j);
  };

  it("accepts the valid fixture", () => {
    const r = parseTokens(valid, "tokens.json");
    expect(r.findings).toEqual([]);
    expect(r.tokens?.version).toBe(1);
  });

  it.each([
    [
      "a lowercase hex color",
      (j: Loose) => {
        j.color.bg.dark = "#0a0a0a";
      },
      "color.bg.dark",
    ],
    [
      "a size that is not a positive integer",
      (j: Loose) => {
        j.size.control.dense = 0;
      },
      "size.control.dense",
    ],
    [
      "a contrast pair naming an unknown token",
      (j: Loose) => {
        j.contrast.push(["nope", "bg", 4.5]);
      },
      "nope",
    ],
    [
      "a missing shadow theme",
      (j: Loose) => {
        delete j.shadow["shadow-1"].dark;
      },
      "shadow.shadow-1.dark",
    ],
    [
      "invalid JSON",
      () => {
        throw new Error("replaced below");
      },
      "JSON",
    ],
  ])("rejects %s", (_name, fn, needle) => {
    let text: string;
    try {
      text = mutate(fn);
    } catch {
      text = "{ not json";
    }
    const r = parseTokens(text, "tokens.json");
    expect(r.findings.map((x) => x.rule)).toContain("tokens-invalid");
    expect(r.findings.map((x) => x.message).join("\n")).toContain(needle);
  });
});

describe("rendering", () => {
  it("renderTokensCss reproduces the valid fixture's tokens.css byte for byte", () => {
    const root = fixture("valid");
    const { tokens } = parseTokens(readFileSync(join(root, JSON_PATH), "utf8"), "tokens.json");
    expect(tokens).toBeDefined();
    if (!tokens) return;
    expect(renderTokensCss(tokens)).toBe(readFileSync(join(root, CSS_PATH), "utf8"));
    expect(renderTokensTs(tokens)).toBe(readFileSync(join(root, TS_PATH), "utf8"));
  });

  it("tokens.ts carries no color values", () => {
    const text = readFileSync(join(repoRoot, JSON_PATH), "utf8");
    const { tokens } = parseTokens(text, "tokens.json");
    if (!tokens) throw new Error("repository tokens.json must parse");
    const ts = renderTokensTs(tokens);
    expect(ts).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|rgba?\(|color-mix/);
  });
});

describe("contrastRatio", () => {
  it("white on black is 21", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 2);
  });

  it("white on the light accent meets the spec §2.1 claim (4.72)", () => {
    expect(contrastRatio("#FFFFFF", "#CC4609")).toBeGreaterThanOrEqual(4.72);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#5E5E5A", "#F7F6F2")).toBeCloseTo(contrastRatio("#F7F6F2", "#5E5E5A"));
  });
});
