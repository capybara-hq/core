import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { headPath } from "@capybara-hq/design";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { adminItemTabs } from "../src/components/admin-item-tabs";
import {
  APP_PAGES,
  buildPagePath,
  isPathWord,
  PATH_WORDS,
  routeSegments,
} from "../src/components/shell/path";
import { pluginTabs } from "../src/lib/admin-tabs";

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

  it("starts the admin console with its name linking to its overview", () => {
    expect(buildPagePath("admin", "capybara", [{ label: "扩展" }], "管理后台")).toEqual([
      { label: "管理后台", href: "/admin" },
      { label: "扩展" },
    ]);
  });
});

describe("route words (names, never URL slugs; maintainer decision 2026-11-28)", () => {
  it("PATH_WORDS lists exactly the keys of the `path` messages, in zh and en", () => {
    for (const scope of ["admin", "org", "home"] as const) {
      expect(Object.keys(zh.path[scope]).sort()).toEqual([...PATH_WORDS[scope]].sort());
      expect(Object.keys(en.path[scope]).sort()).toEqual([...PATH_WORDS[scope]].sort());
    }
  });

  it("the admin words are the admin sidebar's names", () => {
    for (const id of Object.keys(zh.admin.nav).filter((k) => isPathWord("admin", k))) {
      if (id === "settings") continue;
      expect(zh.path.admin[id as keyof typeof zh.path.admin], id).toBe(
        zh.admin.nav[id as keyof typeof zh.admin.nav],
      );
    }
    expect(zh.path.admin.root).toBe("管理后台");
    expect(en.path.admin.root).toBe("Admin console");
    expect(zh.path.admin.templates).toBe(zh.adminItems.tabs.templates);
    expect(zh.path.admin.market).toBe(zh.catalog.admin.tabs.market);
  });

  it("no page head writes a route word as a literal label: they go through usePathWord", () => {
    const root = resolve(import.meta.dirname, "../src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const literal = /\{\s*label:\s*"([a-z][a-z-]*)"\s*(,\s*href:[^}]*)?\}/g;
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(resolve(root, f), "utf8");
      if (!text.includes("usePagePath(")) continue;
      for (const m of text.matchAll(literal)) {
        const word = m[1] ?? "";
        if (PATH_WORDS.admin.includes(word as never) || PATH_WORDS.org.includes(word as never)) {
          found.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("header tabs are one level (maintainer decision 2026-11-28)", () => {
  // Every head whose tabs are routes: each tab route stands at its first tab's level, so none of
  // them draws a path row (two segments or fewer), whatever segments its page writes.
  const t = (k: string) => k;
  const heads = [
    adminItemTabs("agents", "items", { items: "a", templates: "t" }).tabs,
    adminItemTabs("connectors", "items", { items: "c", templates: "t" }).tabs,
    pluginTabs(t),
  ];
  it("each tab route of a head stands at the head's first tab's level", () => {
    for (const tabs of heads) {
      for (const tab of tabs) {
        const { admin, rest } = routeSegments(tab.href ?? "");
        const path = buildPagePath(admin ? "admin" : "org", "acme", rest);
        const stands = headPath(path, tabs, tab.id);
        expect(stands.length, tab.href).toBeLessThanOrEqual(2);
      }
    }
  });
  it("a truly deeper page under a tab keeps its path row", () => {
    const { rest } = routeSegments("/admin/agents/templates/a1");
    const path = buildPagePath("admin", "acme", [...rest]);
    // an item detail is no tab: its head has no tabs, so its path stays
    expect(headPath(path, undefined, undefined).length).toBe(4);
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
