import { describe, expect, it } from "vitest";
import {
  CLIENT_API_VERSION,
  CLIENT_ASSET_TYPES,
  CLIENT_LIMITS,
  type PluginClientSection,
  validateClientSection,
} from "../src/index.js";

const sri = (c = "A") => `sha384-${c.repeat(64)}`;
const ENTRY = "./dist/client/client.mjs";
const css = (n: string) => `./dist/client/styles/${n}.css`;

const section = (over: Partial<PluginClientSection> = {}): PluginClientSection => ({
  entry: ENTRY,
  integrity: { [ENTRY]: sri() },
  apiVersion: 1,
  ...over,
});

describe("validateClientSection", () => {
  it("exports the exact values", () => {
    expect(CLIENT_API_VERSION).toBe(1);
    expect(CLIENT_LIMITS.totalBytes).toBe(8388608);
    expect(Object.keys(CLIENT_ASSET_TYPES)).toEqual([
      ".png",
      ".webp",
      ".svg",
      ".woff2",
      ".mp3",
      ".ogg",
      ".wav",
    ]);
  });

  it("accepts an entry, and a CSS-only section", () => {
    expect(validateClientSection(section())).toEqual([]);
    expect(
      validateClientSection({
        styles: [css("a")],
        integrity: { [css("a")]: sri("B") },
        apiVersion: 1,
      }),
    ).toEqual([]);
  });

  it("a section needs an entry or a style", () => {
    const errs = validateClientSection({ integrity: {}, apiVersion: 1 });
    expect(errs).toContain("client needs an entry or at least one style file");
  });

  it("every file needs a sha384 integrity and nothing else is listed", () => {
    expect(validateClientSection(section({ integrity: {} }))).toContain(
      `client.integrity: missing entry for ${ENTRY}`,
    );
    expect(validateClientSection(section({ integrity: { [ENTRY]: "sha256-abc" } }))).toContain(
      `client.integrity: ${ENTRY} must be sha384-<base64>`,
    );
    expect(
      validateClientSection(section({ integrity: { [ENTRY]: sri(), "./x.js": sri() } })),
    ).toContain("client.integrity: ./x.js is not a listed file");
  });

  it("assets of an unknown type are refused", () => {
    const a = "./dist/client/assets/run.exe";
    const errs = validateClientSection(
      section({ assets: [a], integrity: { [ENTRY]: sri(), [a]: sri() } }),
    );
    expect(errs.some((e) => e.includes("unsupported type"))).toBe(true);
    const ok = "./dist/client/assets/fonts/x.woff2";
    expect(
      validateClientSection(section({ assets: [ok], integrity: { [ENTRY]: sri(), [ok]: sri() } })),
    ).toEqual([]);
  });

  it("paths outside dist/client are refused", () => {
    const e = validateClientSection(
      section({ entry: "./dist/index.mjs", integrity: { "./dist/index.mjs": sri() } }),
    );
    expect(e.some((x) => x.includes("client.entry must be"))).toBe(true);
    const s = "./dist/other/a.css";
    expect(
      validateClientSection(section({ styles: [s], integrity: { [ENTRY]: sri(), [s]: sri() } })),
    ).not.toEqual([]);
    const a = "./dist/client/assets/../../x.png";
    expect(
      validateClientSection(section({ assets: [a], integrity: { [ENTRY]: sri(), [a]: sri() } })),
    ).not.toEqual([]);
  });

  it("nine styles are refused", () => {
    const styles = Array.from({ length: 9 }, (_, i) => css(`s${i}`));
    const integrity = Object.fromEntries(styles.map((p) => [p, sri()]));
    expect(validateClientSection({ styles, integrity, apiVersion: 1 })).toContain(
      "client.styles has 9 files; the limit is 8",
    );
  });

  it("apiVersion must be a positive integer", () => {
    expect(validateClientSection(section({ apiVersion: 0 }))).toContain(
      "client.apiVersion must be a positive integer",
    );
  });
});
