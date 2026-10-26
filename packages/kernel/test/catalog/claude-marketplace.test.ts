import { parseMarketplaceManifest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type ClaudeMarketplace,
  parseClaudeMarketplace,
} from "../../src/catalog/claude/marketplace.js";
import { loadFixture } from "./claude-fixtures.js";

const SHA = "a".repeat(40);
const parse = (json: unknown, allowInsecureLoopback = false): ClaudeMarketplace => {
  const r = parseClaudeMarketplace(json, { allowInsecureLoopback });
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r;
};
const mkt = (plugins: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "acme",
  owner: { name: "Acme" },
  plugins,
  ...extra,
});

describe("parseClaudeMarketplace", () => {
  it("maps every source form", () => {
    const r = parse(
      mkt([
        { name: "root", source: "./" },
        { name: "dot", source: "." },
        { name: "sub", source: "./plugins/sub/" },
        { name: "gh", source: { source: "github", repo: "acme/gh", ref: "v1", sha: SHA } },
        { name: "url", source: { source: "url", url: "https://git.acme.example/u.git" } },
        {
          name: "subdir",
          source: { source: "git-subdir", url: "acme/mono", path: "tools/x", ref: "main" },
        },
        { name: "npm", source: { source: "npm", package: "@acme/x" } },
        {
          name: "zip",
          source: { source: "archive", url: "https://a.example/x.zip", sha256: "b".repeat(64) },
        },
        { name: "cmd", source: { source: "command", command: "x" } },
        { name: "ssh", source: { source: "url", url: "git@github.com:acme/x.git" } },
        { name: "future", source: { source: "somethingnew" } },
      ]),
    );
    expect(r.manifest.plugins.map((e) => [e.name, e.source])).toEqual([
      ["root", { path: "." }],
      ["dot", { path: "." }],
      ["sub", { path: "./plugins/sub" }],
      ["gh", { git: { url: "https://github.com/acme/gh.git", ref: "v1", commit: SHA } }],
      ["url", { git: { url: "https://git.acme.example/u.git" } }],
      [
        "subdir",
        { git: { url: "https://github.com/acme/mono.git", path: "tools/x", ref: "main" } },
      ],
    ]);
    expect(r.skipped).toEqual([
      { name: "npm", reason: "claude_npm_unpinned" },
      { name: "zip", reason: "claude_source_unsupported" },
      { name: "cmd", reason: "claude_source_unsupported" },
      { name: "ssh", reason: "claude_source_unsupported" },
      { name: "future", reason: "claude_source_unsupported" },
    ]);
    // http only on loopback, with the test option.
    const loop = { name: "l", source: { source: "url", url: "http://127.0.0.1:9/x.git" } };
    expect(parse(mkt([loop])).skipped).toEqual([
      { name: "l", reason: "claude_source_unsupported" },
    ]);
    expect(parse(mkt([loop]), true).manifest.plugins).toHaveLength(1);
  });

  it("entries past the 5000 cap are one skipped row naming the range (review M4)", () => {
    const r = parse(
      mkt([{ name: "ok", source: "./ok" }, ...Array.from({ length: 5002 }, () => 7)]),
    );
    expect(r.manifest.plugins.map((p) => p.name)).toEqual(["ok"]);
    expect(r.skipped).toHaveLength(5000);
    expect(r.skipped.at(-1)).toEqual({ name: "plugins[5000…5002]", reason: "invalid_entry" });
  });

  it("metadata.pluginRoot resolves bare names only", () => {
    const r = parse(
      mkt(
        [
          { name: "bare", source: "formatter" },
          { name: "dotted", source: "./elsewhere/x" },
          { name: "nested", source: "team/x" },
        ],
        { metadata: { pluginRoot: "./plugins" } },
      ),
    );
    expect(r.manifest.plugins.map((e) => [e.name, e.source])).toEqual([
      ["bare", { path: "./plugins/formatter" }],
      ["dotted", { path: "./elsewhere/x" }],
    ]);
    expect(r.skipped).toEqual([{ name: "nested", reason: "invalid_entry" }]);
    // Without pluginRoot a bare name is not a path.
    expect(parse(mkt([{ name: "bare", source: "formatter" }])).skipped).toEqual([
      { name: "bare", reason: "invalid_entry" },
    ]);
  });

  it("skips invalid names and entries, ignores renames and unknown keys", () => {
    const r = parse(
      mkt(
        [
          { name: "Upper.Case", source: "./a" },
          { source: "./b" },
          5,
          { name: "ok", source: "./ok", futureKey: 1 },
          { name: "ok", source: "./ok2" },
          { name: "escape", source: "./../x" },
          { name: "badsha", source: { source: "github", repo: "a/b", sha: "abc" } },
        ],
        { renames: { old: "ok" }, forceRemoveDeletedPlugins: true, $schema: "x" },
      ),
    );
    expect(r.manifest.plugins.map((e) => e.name)).toEqual(["ok"]);
    expect(r.skipped).toEqual([
      { name: "Upper.Case", reason: "invalid_name" },
      { name: "plugins[1]", reason: "invalid_entry" },
      { name: "plugins[2]", reason: "invalid_entry" },
      { name: "ok", reason: "invalid_entry" },
      { name: "escape", reason: "invalid_entry" },
      { name: "badsha", reason: "invalid_entry" },
    ]);
    expect(parseClaudeMarketplace({ plugins: [] }, { allowInsecureLoopback: false })).toEqual({
      errors: ["name is required"],
    });
    expect(parseClaudeMarketplace({ name: "x" }, { allowInsecureLoopback: false })).toEqual({
      errors: ["plugins must be an array"],
    });
    expect(parseClaudeMarketplace([], { allowInsecureLoopback: false })).toEqual({
      errors: ["marketplace.json must be a JSON object"],
    });
  });

  it("entry fields, overlays and a claude-plugins-official-shaped sample", () => {
    const r = parse({
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name: "claude-plugins-official",
      description: "Directory of popular Claude Code extensions",
      owner: { name: "Anthropic", email: "support@anthropic.com" },
      plugins: [
        {
          name: "github",
          description: "Official GitHub MCP server",
          category: "development",
          source: { source: "url", url: "https://github.com/acme/github-plugin.git" },
          homepage: "https://github.com/acme/github-plugin",
        },
        {
          name: "pr-review-toolkit",
          description: "x".repeat(400),
          version: "1.0.0",
          author: { name: "Toolkit Team" },
          source: {
            source: "git-subdir",
            url: "https://github.com/acme/claude-code.git",
            path: "plugins/pr-review-toolkit",
          },
          strict: false,
          commands: ["./commands/review.md"],
          mcpServers: { api: { type: "http", url: "https://api.example/mcp" } },
          lspServers: {},
        },
        {
          name: "local-tools",
          source: "./plugins/local-tools",
          version: "not-semver",
          homepage: "http://insecure.example",
          tags: ["x"],
        },
      ],
    });
    expect(r.manifest).toEqual({
      schemaVersion: 1,
      name: "claude-plugins-official",
      owner: { name: "Anthropic" },
      description: "Directory of popular Claude Code extensions",
      plugins: [
        {
          name: "github",
          summary: { en: "Official GitHub MCP server" },
          homepage: "https://github.com/acme/github-plugin",
          source: { git: { url: "https://github.com/acme/github-plugin.git" } },
        },
        {
          name: "pr-review-toolkit",
          summary: { en: "x".repeat(280) },
          version: "1.0.0",
          source: {
            git: {
              url: "https://github.com/acme/claude-code.git",
              path: "plugins/pr-review-toolkit",
            },
          },
        },
        {
          name: "local-tools",
          summary: { en: "Claude Code plugin local-tools" },
          source: { path: "./plugins/local-tools" },
        },
      ],
    });
    expect("errors" in parseMarketplaceManifest(r.manifest)).toBe(false);
    expect(Object.fromEntries(r.overlays)).toEqual({
      github: { strict: true, components: {}, publisher: "Anthropic" },
      "pr-review-toolkit": {
        strict: false,
        components: {
          commands: ["./commands/review.md"],
          mcpServers: { api: { type: "http", url: "https://api.example/mcp" } },
          lspServers: {},
        },
        publisher: "Toolkit Team",
      },
      "local-tools": { strict: true, components: {}, publisher: "Anthropic" },
    });
    expect(r.skipped).toEqual([]);
  });

  it("the superpowers repository's own marketplace", () => {
    const raw = loadFixture("superpowers").get(".claude-plugin/marketplace.json") as Uint8Array;
    const r = parse(JSON.parse(Buffer.from(raw).toString("utf8")));
    expect(r.manifest.name).toBe("superpowers-dev");
    expect(r.manifest.owner).toEqual({ name: "Jesse Vincent" });
    expect(r.manifest.plugins).toEqual([
      {
        name: "superpowers",
        summary: {
          en: "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
        },
        version: "7.0.1",
        source: { path: "." },
      },
    ]);
    expect(r.overlays.get("superpowers")).toEqual({
      strict: true,
      components: {},
      publisher: "Jesse Vincent",
    });
  });
});
