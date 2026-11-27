import { describe, expect, it } from "vitest";
import { narrowReadRoots } from "../../src/sandbox/browse-roots.js";

/** An owner browse narrowed to a project root never reaches beyond the owner's ceiling. */
describe("narrowReadRoots", () => {
  it.each([
    [["/home/me"], ["/home/me/app"], ["/home/me/app"]],
    [["/home/me"], ["/home/me"], ["/home/me"]],
    [["/"], ["/srv/app"], ["/srv/app"]],
    // the project root above the ceiling: refused, never widened
    [["/home/me/app/src"], ["/home/me/app"], []],
    [["/home/me"], ["/"], []],
    // disjoint, or a sibling sharing a prefix: nothing
    [["/workspace"], ["/home/me/app"], []],
    [["/home/me"], ["/home/me2/app"], []],
    // not absolute or not normalized: dropped
    [
      ["/home/me"],
      ["app", "/home/me/./app", "/home/me/app/", "/home/me/x/../app", "/home/me//a"],
      [],
    ],
    [
      ["/home/me", "/workspace"],
      ["/home/me/app", "/workspace", "/home/me/app"],
      ["/home/me/app", "/workspace"],
    ],
  ])("narrows %j by %j to %j", (ceiling, narrow, want) => {
    expect(narrowReadRoots(ceiling, narrow)).toEqual(want);
  });
});
