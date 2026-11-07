import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_PAGES, buildPagePath, routeSegments } from "../src/components/shell/path";

describe("buildPagePath", () => {
  it("puts the org slug first and links it home (the new conversation)", () => {
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

  it("uses ~ for personal pages and for an org page without an org", () => {
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

describe("routeSegments", () => {
  it("links only the segments that are pages", () => {
    expect(routeSegments("/settings/members/x").rest).toEqual([
      { label: "settings" },
      { label: "members", href: "/settings/members" },
      { label: "x" },
    ]);
    expect(routeSegments("/account/grants/x").rest[0]).toEqual({ label: "account" });
    expect(routeSegments("/evals/runs/r1/x").rest).toEqual([
      { label: "evals", href: "/evals" },
      { label: "runs" },
      { label: "r1", href: "/evals/runs/r1" },
      { label: "x" },
    ]);
    expect(routeSegments("/evals/s1/cases/k1").rest).toEqual([
      { label: "evals", href: "/evals" },
      { label: "s1", href: "/evals/s1" },
      { label: "cases" },
      { label: "k1" },
    ]);
    expect(routeSegments("/p/board/overview/x").rest.slice(0, 2)).toEqual([
      { label: "p" },
      { label: "board" },
    ]);
  });

  it("keeps the admin scope in the links and shortens UUIDs", () => {
    const id = "0b5c3a4e-1111-4222-8333-944455556666";
    expect(routeSegments(`/admin/extensions/${id}/x`)).toEqual({
      admin: true,
      rest: [
        { label: "extensions", href: "/admin/extensions" },
        { label: "0b5c3a4e", href: `/admin/extensions/${id}` },
        { label: "x" },
      ],
    });
  });

  it("lists every page of the app", () => {
    const root = resolve(import.meta.dirname, "../src/app/(app)");
    const pages = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith("page.tsx") && !f.includes("[..."))
      .map((f) => `/${f.replace(/\/?page\.tsx$/, "")}`)
      .sort();
    expect([...APP_PAGES].sort()).toEqual(pages);
  });
});
