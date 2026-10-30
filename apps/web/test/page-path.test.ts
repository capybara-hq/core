import { describe, expect, it } from "vitest";
import { buildPagePath } from "../src/components/shell/path";

describe("buildPagePath", () => {
  it("puts the org slug first and links it to the root", () => {
    expect(
      buildPagePath("org", "capybara", [
        { label: "agents", href: "/agents" },
        { label: "研究助手" },
      ]),
    ).toEqual([
      { label: "capybara", href: "/" },
      { label: "agents", href: "/agents" },
      { label: "研究助手" },
    ]);
  });

  it("uses ~ for the home page and for an org page without an org", () => {
    expect(buildPagePath("home", "capybara", [])).toEqual([{ label: "~" }]);
    expect(buildPagePath("org", undefined, [{ label: "agents" }])).toEqual([
      { label: "~", href: "/" },
      { label: "agents" },
    ]);
  });

  it("starts the admin console with /admin linking to its overview", () => {
    expect(buildPagePath("admin", "capybara", [{ label: "extensions" }])).toEqual([
      { label: "/admin", href: "/admin" },
      { label: "extensions" },
    ]);
  });
});
