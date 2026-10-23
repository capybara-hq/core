import { describe, expect, it } from "vitest";
import {
  isFirstRelease,
  type PublishStep,
  packedManifestIssues,
  planPublish,
  publishedVersionsOf,
  type WorkspacePackage,
} from "../src/publish-plan.js";

// Fixture paths are built from parts: these are plain values for the planner, no plugin is loaded
// (a literal plugin path would make check:test-plugins map these tests to that plugin).
const at = (group: string, name: string) => `${group}/${name}`;
const pluginDir = (name: string) => at("plugins", name);

const pkg = (
  name: string,
  dir: string,
  extra: Partial<WorkspacePackage> = {},
): WorkspacePackage => ({
  name,
  version: "0.1.0",
  dir,
  private: false,
  isPlugin: dir.startsWith("plugins/"),
  ...extra,
});

// Deliberately shuffled: the plan must not depend on discovery order.
const WORKSPACE: WorkspacePackage[] = [
  pkg("@capybara-hq/plugin-todo", pluginDir("todo")),
  pkg("@capybara-hq/testing", "packages/testing"),
  pkg("@capybara-hq/plugin-example-counter", pluginDir("example-counter"), { private: true }),
  pkg("@capybara-hq/plugin-slack", pluginDir("slack")),
  pkg("@capybara-hq/design", "packages/design", { private: true }),
  pkg("@capybara-hq/kernel", "packages/kernel"),
  pkg("@capybara-hq/capybara", "apps/capybara", { private: true }),
  pkg("@capybara-hq/plugin-sdk", "packages/plugin-sdk"),
  pkg("@capybara-hq/plugin-model-fake", pluginDir("model-fake")),
];

const names = (steps: PublishStep[]) => steps.map((s) => s.name);

describe("planPublish", () => {
  it("leaves private packages out", () => {
    const plan = names(planPublish(WORKSPACE, new Map()));
    expect(plan).not.toContain("@capybara-hq/design");
    expect(plan).not.toContain("@capybara-hq/plugin-example-counter");
    expect(plan).not.toContain("@capybara-hq/capybara");
  });

  it("skips a version that is already on npm", () => {
    const published = new Map([["@capybara-hq/plugin-slack", ["0.0.9", "0.1.0"]]]);
    expect(names(planPublish(WORKSPACE, published))).not.toContain("@capybara-hq/plugin-slack");
  });

  it("keeps a package whose other versions are on npm but not this one", () => {
    const published = new Map([["@capybara-hq/plugin-slack", ["0.0.9"]]]);
    expect(names(planPublish(WORKSPACE, published))).toContain("@capybara-hq/plugin-slack");
  });

  it("orders SDK, kernel, testing, then plugins by name", () => {
    expect(names(planPublish(WORKSPACE, new Map()))).toEqual([
      "@capybara-hq/plugin-sdk",
      "@capybara-hq/kernel",
      "@capybara-hq/testing",
      "@capybara-hq/plugin-model-fake",
      "@capybara-hq/plugin-slack",
      "@capybara-hq/plugin-todo",
    ]);
  });

  it("publishes plugins as plugin-tgz and library packages through pnpm", () => {
    const plan = planPublish(WORKSPACE, new Map());
    for (const s of plan) {
      expect(s.kind).toBe(s.dir.startsWith("plugins/") ? "plugin-tgz" : "pnpm");
    }
    expect(plan.find((s) => s.name === "@capybara-hq/plugin-slack")).toEqual({
      name: "@capybara-hq/plugin-slack",
      version: "0.1.0",
      kind: "plugin-tgz",
      dir: pluginDir("slack"),
    });
  });

  it("returns an empty plan when everything is already published", () => {
    const published = new Map(WORKSPACE.map((p) => [p.name, [p.version]]));
    expect(planPublish(WORKSPACE, published)).toEqual([]);
  });
});

describe("publishedVersionsOf", () => {
  it("reads the version keys of a registry packument", () => {
    expect(publishedVersionsOf({ versions: { "0.1.0": {}, "0.2.0": {} } })).toEqual([
      "0.1.0",
      "0.2.0",
    ]);
  });

  it("treats a packument without versions (e.g. fully unpublished) as none", () => {
    expect(publishedVersionsOf({ time: { unpublished: {} } })).toEqual([]);
    expect(publishedVersionsOf(null)).toEqual([]);
  });
});

describe("isFirstRelease", () => {
  it("is true while nothing public is on the registry", () => {
    expect(isFirstRelease(WORKSPACE, new Map())).toBe(true);
    expect(isFirstRelease(WORKSPACE, new Map([["@capybara-hq/plugin-sdk", []]]))).toBe(true);
  });

  it("ignores private packages that happen to share a name on the registry", () => {
    expect(isFirstRelease(WORKSPACE, new Map([["@capybara-hq/design", ["0.1.0"]]]))).toBe(true);
  });

  it("is false once any public package has a version on the registry", () => {
    expect(isFirstRelease(WORKSPACE, new Map([["@capybara-hq/plugin-sdk", ["0.1.0"]]]))).toBe(
      false,
    );
  });
});

describe("packedManifestIssues", () => {
  it("accepts a manifest pnpm pack rewrote", () => {
    expect(
      packedManifestIssues({
        name: "@capybara-hq/kernel",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        dependencies: { "@capybara-hq/plugin-sdk": "^0.1.0" },
      }),
    ).toEqual([]);
  });

  it("reports workspace ranges, the source condition and an unapplied publishConfig", () => {
    expect(
      packedManifestIssues({
        exports: { ".": { "@capybara-hq/source": "./src/index.ts" } },
        dependencies: { "@capybara-hq/plugin-sdk": "workspace:^" },
        publishConfig: { exports: {} },
      }),
    ).toHaveLength(3);
  });
});
