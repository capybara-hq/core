import { describe, expect, it } from "vitest";
import { findRepeat } from "../../src/tools/builtins/delivery-scope.js";

/**
 * Truthful delivery spec §2 step 3: the repeat decision. M = the latest scope artifact with the
 * hash, L = the latest with the source path; a repeat of M iff M exists and L does not come after M.
 */

const a = (seq: number, sha: string, src: string) => ({
  seq,
  artifactId: `id${seq}`,
  name: `n${seq}`,
  sha256: sha,
  sourcePath: src,
});

/** An artifact written before `sha256` existed. */
const unhashed = ({ sha256: _, ...rest }: ReturnType<typeof a>) => rest;

describe("findRepeat", () => {
  it("a repeat of the latest same-content artifact", () =>
    expect(
      findRepeat({ boundary: 0, artifacts: [a(5, "A", "generated/c/x.png")] }, "A", "/w/x.png")
        .repeatOf?.seq,
    ).toBe(5));

  it("v1, v2, v1 of one path delivers again", () =>
    expect(
      findRepeat({ boundary: 0, artifacts: [a(5, "A", "/w/f"), a(7, "B", "/w/f")] }, "A", "/w/f"),
    ).toEqual({ repeatOf: null, lastOfSource: 7 }));

  it("v1, v1 is a repeat", () =>
    expect(
      findRepeat({ boundary: 0, artifacts: [a(5, "A", "/w/f")] }, "A", "/w/f").repeatOf?.seq,
    ).toBe(5));

  it("an artifact without sha256 never matches", () =>
    expect(
      findRepeat({ boundary: 0, artifacts: [unhashed(a(5, "A", "/w/f"))] }, "A", "/w/f").repeatOf,
    ).toBeNull());

  it("the latest of several same-content artifacts is the one repeated", () =>
    expect(
      findRepeat(
        { boundary: 0, artifacts: [a(3, "A", "/w/a"), a(4, "A", "/w/b"), a(6, "C", "/w/c")] },
        "A",
        "/w/d",
      ),
    ).toEqual({ repeatOf: a(4, "A", "/w/b"), lastOfSource: 0 }));

  it("an empty scope has no repeat and no earlier version", () =>
    expect(findRepeat({ boundary: 9, artifacts: [] }, "A", "/w/f")).toEqual({
      repeatOf: null,
      lastOfSource: 0,
    }));
});
