import { ToolError, type ToolResult } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { skillLoadTool } from "../../src/tools/builtins/skill-load.js";

/**
 * Project root spec §4.5: `Skill` loads `project:<name>` from the root conversation's latest
 * `project_root` and reads `<root>/.agents/skills/<name>/SKILL.md` through the device provider.
 * Stubbed deps: the project path never touches the database or file storage.
 */

type ProjectRoot = EventPayload<"project_root">;

const ROOT = "/Users/u/src/core";
const ROOTS = { workspace: "/w", skills: "/s", tmp: "/t" };

const usable: ProjectRoot = {
  project: "core",
  root: ROOT,
  skills: [
    { name: "fix-issue", description: "Fix an issue.", digest: "a".repeat(64) },
    { name: "release", description: "Cut a release.", digest: "b".repeat(64) },
  ],
};

const gone: ProjectRoot = {
  project: "core",
  root: ROOT,
  skills: [],
  unavailable: {
    reason: "gone",
    message: `The project's root ${ROOT} no longer exists on the device.`,
  },
};

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: A skill.\n---\n${body}\n`;

interface Setup {
  project?: ProjectRoot | null;
  catalog?: EventPayload<"skills_catalog">;
  files?: Record<string, string>;
  readError?: Error;
  /** The device's mode now (default auto: the project's root is outside the sandbox roots). */
  mode?: "auto" | "sandbox";
}

function setup(s: Setup) {
  const asked: { conversation: string; type: string }[] = [];
  const reads: string[] = [];
  const event = (type: string, payload: unknown) =>
    ({
      conversationId: "root",
      seq: 3,
      runId: "r",
      createdAt: new Date(),
      type,
      payload,
    }) as ConversationEvent;
  const p = {
    readFile: async (_h: unknown, path: string) => {
      reads.push(path);
      if (s.readError) throw s.readError;
      const text = s.files?.[path];
      return text === undefined ? null : { data: new TextEncoder().encode(text), truncated: false };
    },
    writeFile: async () => {
      throw new Error("a project skill writes nothing");
    },
  };
  const tool = skillLoadTool({
    db: {} as never,
    storage: {} as never,
    eventLog: {
      append: async () => [],
      latestFileState: async () => null,
      latestOfType: (async (conversation: string, type: string) => {
        asked.push({ conversation, type });
        if (type === "project_root" && s.project) return event(type, s.project);
        if (type === "skills_catalog" && s.catalog) return event(type, s.catalog);
        return undefined;
      }) as never,
    },
    sandbox: {
      cloudAvailable: true,
      availableFor: async () => true,
      withSandbox: async (_c, fn, sig) =>
        fn(
          { id: "e1", roots: ROOTS } as never,
          p as never,
          { fresh: false, restarted: false, roots: ROOTS } as never,
          sig,
        ),
    },
    devices: {
      forTool: async () => "device-1",
      modeLevel: async () => ({
        mode: s.mode ?? "auto",
        allowedMode: "auto" as const,
        network: { kind: "allowlist" as const, hosts: [] },
        local: true,
      }),
    },
    attachments: { listForConversation: async () => [], openForConversation: async () => null },
    config: { get: () => ({ sandbox: { limits: {} } }) as never },
  });
  const ctx = (over: Record<string, unknown> = {}) => ({
    orgId: "org",
    accountId: "acc",
    agentId: "a",
    conversationId: "root",
    callId: "call-1",
    signal: new AbortController().signal,
    ...over,
  });
  const run = async (input: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    (await tool.run(input, ctx(over))) as ToolResult;
  return { run, asked, reads };
}

const textOf = (r: ToolResult) => (r.content[0] as { text: string }).text;
const PATH = `${ROOT}/.agents/skills/fix-issue/SKILL.md`;

async function toolError(p: Promise<unknown>): Promise<ToolError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ToolError);
  return e as ToolError;
}

describe("Skill: project skills", () => {
  it("reads the body from the project's root on the device and returns it with its args", async () => {
    const t = setup({
      project: usable,
      files: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the Claude Code variable
        [PATH]: skillMd("fix-issue", "Fix issue $0. Helpers: ${CLAUDE_SKILL_DIR}/scripts."),
      },
    });
    const text = textOf(await t.run({ skill: "project:fix-issue", args: "42" }));
    expect(t.reads).toEqual([PATH]);
    expect(text).toContain('Loaded project skill "project:fix-issue"');
    expect(text).toContain(`Fix issue 42. Helpers: ${ROOT}/.agents/skills/fix-issue/scripts.`);
    expect(text).toContain('<skill name="project:fix-issue">');
    expect(text).not.toContain("\u0000");
  });

  it("a sub-agent resolves its own copy of the project, the one it was shown", async () => {
    const t = setup({ project: usable, files: { [PATH]: skillMd("fix-issue", "Body.") } });
    await t.run(
      { skill: "project:fix-issue" },
      { conversationId: "child", sandboxConversationId: "root" },
    );
    expect(t.asked).toContainEqual({ conversation: "child", type: "project_root" });
    expect(t.asked.some((a) => a.conversation === "root" && a.type === "project_root")).toBe(false);
  });

  it("a name the project does not list: an actionable error naming the listed ones", async () => {
    const t = setup({ project: usable });
    const e = await toolError(t.run({ skill: "project:nope" }));
    expect(e.message).toContain("project:fix-issue");
    expect(e.message).toContain("project:release");
    expect(t.reads).toEqual([]);
  });

  it("an unavailable project: an error with the reason, nothing read", async () => {
    const t = setup({ project: gone });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(e.message).toContain("no longer exists on the device");
    expect(t.reads).toEqual([]);
  });

  it("no project in the conversation: an actionable error", async () => {
    const t = setup({ project: null });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(e.message).toMatch(/no project/i);
  });

  it("the file is gone on the device: an actionable error", async () => {
    const t = setup({ project: usable, files: {} });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(e.message).toContain(PATH);
  });

  it("a device error reading the file: an actionable error with its message", async () => {
    const t = setup({ project: usable, readError: new Error("permission denied") });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(e.message).toContain("permission denied");
  });

  it("an unparsable SKILL.md: an actionable error", async () => {
    const t = setup({ project: usable, files: { [PATH]: "no frontmatter" } });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(e.message).toContain("SKILL.md");
  });
  it("a mode narrowed to sandbox since the run started: the root outside the roots is refused, nothing read", async () => {
    const t = setup({
      project: usable,
      mode: "sandbox",
      files: { [PATH]: skillMd("fix-issue", "Body.") },
    });
    const e = await toolError(t.run({ skill: "project:fix-issue" }));
    expect(t.reads).toEqual([]);
    expect(e.message).toContain(PATH);
    expect(e.message).toMatch(/sandbox mode/);
    expect(e.message).toMatch(/ask the user|do the task without/i);
  });
});
