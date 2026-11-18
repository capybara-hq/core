import { SKILL_INVOCATION_LIMITS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import { SandboxProviderUnreachableError } from "../../src/sandbox/unreachable.js";
import {
  invocableSource,
  projectInvocables,
  projectSkillBlocked,
  SkillInvoker,
} from "../../src/skills/invoke.js";
import type { SandboxSession } from "../../src/tools/builtins/sandbox/common.js";

/** The working root of each session a project skill is read in (it is built inside the invoker). */
const sessionRoots = vi.hoisted(() => [] as string[]);
vi.mock("../../src/tools/builtins/skill-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/builtins/skill-load.js")>();
  return {
    ...actual,
    readProjectSkill: (s: SandboxSession, ...rest: [string, string]) => {
      sessionRoots.push(s.workingRoot);
      return actual.readProjectSkill(s, ...rest);
    },
  };
});

/**
 * Project root spec §4.6: the `/` menu's entries carry their `source`, a bound conversation's
 * latest usable `project_root` adds its skills as `project:<name>`, and a person's invocation of
 * one reads its SKILL.md through the conversation's device the way `Skill` does. Stubbed deps: the
 * project path never touches the database or file storage.
 */

type ProjectRoot = EventPayload<"project_root">;

const ROOT = "/Users/u/src/core";
const ROOTS = { workspace: "/w", skills: "/s", tmp: "/t" };
const PATH = `${ROOT}/.agents/skills/fix-issue/SKILL.md`;

const usable: ProjectRoot = {
  project: "core",
  root: ROOT,
  agentsMd: "Rules.",
  skills: [
    { name: "fix-issue", description: "Fix an issue.", digest: "a".repeat(64) },
    { name: "release", description: "Cut a release.", digest: "b".repeat(64) },
  ],
};

const gone: ProjectRoot = {
  project: "core",
  root: ROOT,
  skills: [],
  unavailable: { reason: "gone", message: `The project's root ${ROOT} no longer exists.` },
};

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: A skill.\n---\n${body}\n`;

describe("invocableSource", () => {
  it("names where an effective skill comes from", () => {
    expect(invocableSource({ scope: "agent", skill: { plugin: undefined } })).toBe("agent");
    expect(invocableSource({ scope: "agent", skill: { plugin: "superpowers" } })).toBe("agent");
    expect(invocableSource({ scope: "org", skill: { plugin: "superpowers" } })).toBe("plugin");
    expect(invocableSource({ scope: "org", skill: { plugin: undefined } })).toBe("platform");
  });
});

describe("projectInvocables", () => {
  it("lists a usable project's skills as project:<name>, sorted, source project", () => {
    expect(projectInvocables(usable)).toEqual([
      {
        id: "project:fix-issue",
        name: "project:fix-issue",
        description: "Fix an issue.",
        version: 0,
        manual: false,
        fork: false,
        source: "project",
      },
      {
        id: "project:release",
        name: "project:release",
        description: "Cut a release.",
        version: 0,
        manual: false,
        fork: false,
        source: "project",
      },
    ]);
  });

  it("lists nothing for an unavailable project or none", () => {
    expect(projectInvocables(gone)).toEqual([]);
    expect(projectInvocables(undefined)).toEqual([]);
  });

  it("leaves out a skill whose callable name is too long for Skill", () => {
    const long = { name: "x".repeat(60), description: "Long.", digest: "c".repeat(64) };
    expect(projectInvocables({ ...usable, skills: [long] })).toEqual([]);
  });
});

describe("projectSkillBlocked", () => {
  it("is null while the latest usable project still lists the skill", () => {
    expect(projectSkillBlocked(usable, "project:fix-issue")).toBeNull();
  });
  it("is not_found for an unknown name, an unavailable project or none", () => {
    expect(projectSkillBlocked(usable, "project:nope")).toBe("not_found");
    expect(projectSkillBlocked(gone, "project:fix-issue")).toBe("not_found");
    expect(projectSkillBlocked(undefined, "project:fix-issue")).toBe("not_found");
  });
});

interface Setup {
  project?: ProjectRoot | null;
  files?: Record<string, string>;
  readError?: Error;
  mode?: "auto" | "sandbox";
  /** The SKILL.md was cut at the read limit. */
  truncated?: boolean;
  /** What entering the device throws (the provider unreachable, ...). */
  useError?: Error;
  /** The working facts the device service answers (default: the snapshot's root, usable). */
  working?: {
    workspace: string;
    home: string | null;
    project: { root: string; unavailable: boolean } | null;
  };
}

function setup(s: Setup) {
  const reads: string[] = [];
  const asked: string[] = [];
  const uses: { holderConversationId: string; silent?: true; actor: unknown }[] = [];
  const factsAsked: unknown[][] = [];
  sessionRoots.length = 0;
  const p = {
    readFile: async (_h: unknown, path: string) => {
      reads.push(path);
      if (s.readError) throw s.readError;
      const text = s.files?.[path];
      return text === undefined
        ? null
        : { data: new TextEncoder().encode(text), truncated: s.truncated === true };
    },
  };
  const invoker = new SkillInvoker(
    {} as never,
    {} as never,
    {} as never,
    { error: () => {}, warn: () => {}, info: () => {} } as never,
    {
      latestOfType: (async (conversation: string, type: string) => {
        asked.push(`${conversation}:${type}`);
        if (type !== "project_root" || !s.project) return undefined;
        return {
          conversationId: conversation,
          seq: 3,
          createdAt: new Date(),
          type,
          payload: s.project,
        } as ConversationEvent;
      }) as never,
    },
    {
      withSandbox: (async (
        c: { holderConversationId: string; silent?: true; actor: unknown },
        fn: (...a: unknown[]) => unknown,
        sig?: AbortSignal,
      ) => {
        if (s.useError) throw s.useError;
        uses.push({
          holderConversationId: c.holderConversationId,
          ...(c.silent ? { silent: c.silent } : {}),
          actor: c.actor,
        });
        return fn(
          { id: "e1", roots: ROOTS },
          p,
          { fresh: false, restarted: false, roots: ROOTS },
          sig,
        );
      }) as never,
    },
    {
      forTool: async () => "device-1",
      projectReach: async (): Promise<"workspace" | "os-user"> =>
        (s.mode ?? "auto") === "auto" ? "os-user" : "workspace",
      workingFacts: async (...args: unknown[]) => {
        factsAsked.push(args);
        return (
          s.working ?? {
            workspace: "/Users/u/.capybara/workspace",
            home: "/Users/u",
            project: { root: ROOT, unavailable: false },
          }
        );
      },
      modeLevel: async () => ({
        mode: s.mode ?? "auto",
        allowedMode: "auto" as const,
        network: { kind: "allowlist" as const, hosts: [] },
        local: true,
      }),
    },
    // the send-time device read is the dormant (gate-off) route, kept behind the explicit test
    // seam; the activated stub is covered by non-tool-callers.test.ts and invoke.http.test.ts
    false,
  );
  const prepare = (name: string, args = "", conversationId: string | null = "conv") =>
    invoker.prepare({
      orgId: "org",
      agentId: "agent",
      accountId: "acc",
      ...(conversationId !== null && { conversationId }),
      agent: { name: "A" } as never,
      name,
      args,
    });
  return { prepare, reads, asked, uses, factsAsked };
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("SkillInvoker.prepare: project:<name>", () => {
  it("reads the SKILL.md on the conversation's device and renders the invocation", async () => {
    const t = setup({
      project: usable,
      files: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the Claude Code variable
        [PATH]: skillMd("fix-issue", "Fix issue $ARGUMENTS. Helpers: ${CLAUDE_SKILL_DIR}/scripts."),
      },
    });
    const r = await t.prepare("project:fix-issue", "42");
    expect(t.reads).toEqual([PATH]);
    expect(t.asked).toEqual(["conv:project_root"]);
    expect(r.text).toContain(
      'The user invoked the skill "project:fix-issue" with /project:fix-issue 42',
    );
    expect(r.text).toContain(`Fix issue 42. Helpers: ${ROOT}/.agents/skills/fix-issue/scripts.`);
    expect(r.text).toContain(`${ROOT}/.agents/skills/fix-issue/`);
    expect(r.skill).toEqual({
      id: "project:fix-issue",
      version: 0,
      source: "project",
      name: "project:fix-issue",
      arguments: "42",
      mode: "inline",
    });
    expect(r.task).toBeUndefined();
    // a read that tells the model nothing: the device's notices stay for its next tool call
    expect(t.uses).toEqual([
      {
        holderConversationId: "conv",
        silent: true,
        actor: { accountId: "acc", conversationId: "conv" },
      },
    ]);
  });

  it("reads in the working root a tool call of the conversation would get", async () => {
    const t = setup({ project: usable, files: { [PATH]: skillMd("fix-issue", "B.") } });
    await t.prepare("project:fix-issue");
    expect(t.factsAsked).toEqual([["org", "conv", "conv", "device-1"]]);
    expect(sessionRoots).toEqual([ROOT]);
    // a root the working-root rule refuses (above the owner's home): the held workspace
    const above = setup({
      project: usable,
      files: { [PATH]: skillMd("fix-issue", "B.") },
      working: {
        workspace: "/Users/u/w",
        home: "/Users/u",
        project: { root: "/Users", unavailable: false },
      },
    });
    await above.prepare("project:fix-issue");
    expect(sessionRoots).toEqual([ROOTS.workspace]);
  });

  it("a conversation not created yet has no project: not_found", async () => {
    const t = setup({ project: usable });
    const e = await refusal(t.prepare("project:fix-issue", "", null));
    expect(e.code).toBe("skill.not_invocable");
    expect(e.details).toEqual([{ reason: "not_found" }]);
    expect(t.reads).toEqual([]);
  });

  it("a name the project does not list, or no project: not_found, nothing read", async () => {
    const a = setup({ project: usable });
    expect((await refusal(a.prepare("project:nope"))).details).toEqual([{ reason: "not_found" }]);
    const b = setup({ project: null });
    expect((await refusal(b.prepare("project:fix-issue"))).details).toEqual([
      { reason: "not_found" },
    ]);
    expect([...a.reads, ...b.reads]).toEqual([]);
  });

  it("an unavailable project: skill.project_unavailable with the project's reason, nothing read", async () => {
    const t = setup({ project: gone });
    const e = await refusal(t.prepare("project:fix-issue"));
    expect(e.code).toBe("skill.project_unavailable");
    expect(e.details).toEqual([{ reason: "gone" }]);
    expect(e.message).toContain('"core"');
    expect(t.reads).toEqual([]);
  });

  it("the file is gone, unreadable or unparsable on the device: the reason, and the path named", async () => {
    for (const [s, reason] of [
      [{ files: {} }, "gone"],
      [{ readError: new Error("permission denied") }, "unreadable"],
      [{ files: { [PATH]: "no frontmatter" } }, "unparsable"],
    ] as [Setup, string][]) {
      const t = setup({ project: usable, ...s });
      const e = await refusal(t.prepare("project:fix-issue"));
      expect(e.code).toBe("skill.project_unavailable");
      expect(e.details).toEqual([{ reason }]);
      expect(e.message).toContain(PATH);
    }
  });

  it("a SKILL.md cut at the read limit says so in the invocation", async () => {
    const t = setup({
      project: usable,
      truncated: true,
      files: { [PATH]: skillMd("fix-issue", "Body.") },
    });
    const r = await t.prepare("project:fix-issue");
    expect(r.text).toContain("cut at 1 MiB");
  });

  it("an invocation over the rendered limit with its closing lines is refused", async () => {
    const body = "x".repeat(SKILL_INVOCATION_LIMITS.renderedMaxChars - 150);
    const t = setup({ project: usable, files: { [PATH]: skillMd("fix-issue", body) } });
    const e = await refusal(t.prepare("project:fix-issue"));
    expect(e.code).toBe("validation_failed");
  });

  it("an unreachable sandbox provider keeps its own text", async () => {
    const t = setup({
      project: usable,
      useError: new SandboxProviderUnreachableError("connect", new Error("ECONNREFUSED")),
    });
    const e = await refusal(t.prepare("project:fix-issue"));
    expect(e.code).toBe("device.projects_unavailable");
    expect(e.message).toMatch(/sandbox provider cannot be reached/);
  });

  it("a mode narrowed to sandbox: the root outside the roots is refused, nothing read", async () => {
    const t = setup({
      project: usable,
      mode: "sandbox",
      files: { [PATH]: skillMd("fix-issue", "B.") },
    });
    const e = await refusal(t.prepare("project:fix-issue"));
    expect(e.code).toBe("skill.project_unavailable");
    expect(e.details).toEqual([{ reason: "outside_mode" }]);
    expect(e.message).toContain("sandbox mode");
    expect(t.reads).toEqual([]);
  });
});
