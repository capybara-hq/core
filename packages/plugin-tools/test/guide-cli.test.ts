import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_MANIFEST_FILE } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guideCommand } from "../src/guide/cli.js";

// `capybara-plugin guide <id>`: prints a guide rendered as an admin or member would see it.

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let stdout: string[];
let stderr: string[];
beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    stderr.push(a.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("capybara-plugin guide", () => {
  it("guide prints rendered blocks with --var", async () => {
    const code = await guideCommand(
      [
        "app",
        "--mode",
        "webhook",
        "--var",
        "webhookUrl=https://c.example.com/hook",
        "--var",
        'connectionName=Ops "bot"',
      ],
      fixture("guides-channel"),
    );
    expect(code).toBe(0);
    const text = stdout.join("\n");
    expect(text).toBe(
      [
        "# Create the app",
        "",
        "Open the console and create an app.",
        "",
        "Events go to `https://c.example.com/hook`.",
        "",
        '```json title="App manifest"',
        '{ "name": "Ops \\"bot\\"", "url": "https://c.example.com/hook" }',
        "```",
        "",
        '```sh title="Install"',
        'install --name Ops "bot"',
        "```",
        "",
        "[check capybara:public-url] Public URL is reachable",
        "",
        "unresolved: none",
      ].join("\n"),
    );
    // the validator's warnings go to stderr and do not fail the command
    expect(stderr.join("\n")).toMatch(/warning: guides\/app\.md:\d+: the text variable/);
  });

  it("defaults to the place's first mode and its first audience, and renders zh", async () => {
    expect(await guideCommand(["app", "--locale", "zh"], fixture("guides-channel"))).toBe(0);
    const text = stdout.join("\n");
    expect(text.startsWith("# 创建应用\n")).toBe(true);
    expect(text).not.toContain("事件发到");
    expect(text).toContain("[check capybara:public-url] 公网地址可访问");
    expect(text).toMatch(/unresolved: .*connectionName/);
  });

  it("lists as unresolved only the variables that still have no value", async () => {
    const dir = fixture("guides-channel");
    const args = ["app", "--mode", "webhook", "--var", "connectionName=Ops bot"];
    expect(await guideCommand(args, dir)).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain('{ "name": "Ops bot", "url": "{{webhookUrl}}" }');
    expect(text.split("\n").at(-1)).toBe("unresolved: webhookUrl");
  });

  it("refuses an unknown guide, mode, audience or variable", async () => {
    const dir = fixture("guides-channel");
    expect(await guideCommand(["nope"], dir)).toBe(2);
    expect(stderr.join("\n")).toMatch(/no setup guide "nope".*app/);
    expect(await guideCommand(["app", "--mode", "polling"], dir)).toBe(2);
    expect(stderr.join("\n")).toMatch(/mode polling.*long_connection, webhook/);
    expect(await guideCommand(["app", "--audience", "member"], dir)).toBe(2);
    expect(await guideCommand(["app", "--var", "appSecret=x"], dir)).toBe(2);
    expect(stderr.join("\n")).toMatch(/unknown variable appSecret/);
    expect(await guideCommand(["app", "--var", "novalue"], dir)).toBe(2);
    expect(await guideCommand([], dir)).toBe(2);
  });

  describe("a guide written by the test", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "guide-cli-"));
      await mkdir(join(dir, ".capybara-plugin"));
      await writeFile(
        join(dir, PLUGIN_MANIFEST_FILE),
        JSON.stringify({
          schemaVersion: 1,
          name: "g",
          version: "0.1.0",
          publisher: "Capybara",
          description: "Guide CLI tests",
          setupGuides: [{ id: "app", place: "channel-connection" }],
        }),
      );
      await mkdir(join(dir, "guides"));
      return () => rm(dir, { recursive: true, force: true });
    });

    it("exits 1 with the issues", async () => {
      await writeFile(join(dir, "guides/app.md"), "No title\n\nUses {{appSecret}}.\n");
      expect(await guideCommand(["app"], dir)).toBe(1);
      const err = stderr.join("\n");
      expect(err).toMatch(/guides\/app\.md:1: .*level-1 heading/);
      expect(err).toMatch(/unknown variable \{\{appSecret\}\}/);
      expect(stdout).toEqual([]);
    });

    it("fills {{mode}} from the mode rendered, as the kernel does", async () => {
      await writeFile(
        join(dir, "guides/app.md"),
        "# App\n\n::: mode webhook\nMode `{{mode}}` for {{connectionName}}.\n:::\n",
      );
      const args = ["app", "--mode", "webhook", "--var", "connectionName=Ops"];
      expect(await guideCommand(args, dir)).toBe(0);
      expect(stdout.join("\n")).toBe(
        ["# App", "", "Mode `webhook` for Ops.", "", "unresolved: none"].join("\n"),
      );
      // the mode comes from --mode only
      expect(await guideCommand(["app", "--var", "mode=webhook"], dir)).toBe(2);
      expect(stderr.join("\n")).toMatch(/--var mode.*--mode/);
    });

    it("exits 1 on a missing document", async () => {
      expect(await guideCommand(["app"], dir)).toBe(1);
      expect(stderr.join("\n")).toMatch(/guides\/app\.md does not exist/);
    });
  });
});
