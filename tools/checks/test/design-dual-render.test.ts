import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DUAL_RENDER_PENDING,
  type DualRenderPending,
  dualRenderTreeFindings,
} from "../src/design-dual-render.js";

const fx = (name: string) =>
  fileURLToPath(new URL(`../fixtures/design-dual-render/${name}`, import.meta.url));
const where = (name: string, pending: DualRenderPending[] = []) =>
  dualRenderTreeFindings(fx(name), pending);
const entry = (path: string, max: number): DualRenderPending => ({ path, max, fix: "test" });

describe("design-dual-render", () => {
  it("a function pairing useHydrated with a class query fails; class-forms.tsx is exempt", () => {
    const f = where("violation");
    expect(f.map((x) => [x.rule, x.file.endsWith("pair.tsx"), x.line])).toEqual([
      ["design-dual-render", true, 5],
      ["design-dual-render", true, 11],
      ["design-dual-render", true, 17],
    ]);
    expect(f[0]?.message).toContain("useSizeClass");
    expect(f[1]?.message).toContain("useMediaQuery(<class query>)");
    expect(f[2]?.message).toContain("useTouch");
    expect(f[0]?.message).toContain("ClassForms");
  });

  it("each alone, an unrelated query and nested functions pass", () => {
    expect(where("ok")).toEqual([]);
  });

  it("a pending entry hides its findings up to max", () => {
    expect(where("violation", [entry("shell/pair.tsx", 3)])).toEqual([]);
  });

  it("past max every finding of the entry is reported", () => {
    const f = where("violation", [entry("shell/pair.tsx", 2)]);
    expect(f).toHaveLength(3);
    expect(f[0]?.message).toContain("allows 2, found 3");
  });

  it("a lower count than max fails as stale (lower max)", () => {
    const f = where("violation", [entry("shell/pair.tsx", 5)]);
    expect(f.map((x) => x.rule)).toEqual(["design-dual-render-stale-pending"]);
    expect(f[0]?.message).toContain("lower max to 3");
  });

  it("an entry whose file is clean or missing fails as stale", () => {
    const f = where("ok", [entry("shell/fine.tsx", 1), entry("shell/gone.tsx", 1)]);
    expect(f.map((x) => x.rule)).toEqual([
      "design-dual-render-stale-pending",
      "design-dual-render-stale-pending",
    ]);
    expect(f[0]?.message).toContain("remove the entry");
    expect(f[1]?.message).toContain("does not exist");
  });

  it("the real pending list names files under shell/", () => {
    expect(DUAL_RENDER_PENDING.every((e) => e.path.startsWith("shell/") && e.max > 0)).toBe(true);
  });
});
