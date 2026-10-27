// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code variables such as ${CLAUDE_SKILL_DIR} are plain text here
import { describe, expect, it } from "vitest";
import {
  hasShellInjection,
  parseSkillArguments,
  renderSkillBody,
  renderSkillInvocation,
  SKILL_INVOCATION_LIMITS,
  type SkillInvocation,
  skillInvocation,
} from "../src/index.js";

const inv: SkillInvocation = { model: true, user: true };

describe("skillInvocation", () => {
  it("defaults to a skill both the model and a person can invoke", () => {
    expect(skillInvocation({})).toEqual({ model: true, user: true });
  });

  it("reads the Claude Code keys", () => {
    expect(
      skillInvocation({
        "disable-model-invocation": true,
        context: "fork",
        agent: "code-reviewer",
        "argument-hint": "[n]",
        arguments: ["issue"],
      }),
    ).toEqual({
      model: false,
      user: true,
      fork: { agent: "code-reviewer" },
      argumentHint: "[n]",
      arguments: ["issue"],
    });
    expect(skillInvocation({ "user-invocable": false, context: "fork" })).toEqual({
      model: true,
      user: false,
      fork: {},
    });
  });

  it("reads an unquoted YAML argument-hint ([issue-number]) back as written", () => {
    expect(skillInvocation({ "argument-hint": ["issue-number"] }).argumentHint).toBe(
      "[issue-number]",
    );
    expect(skillInvocation({ "argument-hint": ["a", "b"] }).argumentHint).toBe("[a, b]");
  });

  it("ignores values of the wrong type (parseSkillMd reports them)", () => {
    expect(
      skillInvocation({
        "disable-model-invocation": "yes",
        "user-invocable": 0,
        context: "inline",
        agent: 3,
        "argument-hint": 7,
        arguments: "x",
      }),
    ).toEqual({ model: true, user: true });
  });

  it("exposes the limits", () => {
    expect(SKILL_INVOCATION_LIMITS).toEqual({
      argumentHintMaxChars: 200,
      argumentNames: 20,
      argumentsMaxChars: 10_000,
    });
  });
});

describe("parseSkillArguments", () => {
  it("splits like a shell: quotes group, backslash escapes", () => {
    expect(parseSkillArguments('"hello world" second \\"x')).toEqual([
      "hello world",
      "second",
      '"x',
    ]);
    expect(parseSkillArguments("'a b' c")).toEqual(["a b", "c"]);
    expect(parseSkillArguments("  a\t\nb  ")).toEqual(["a", "b"]);
    expect(parseSkillArguments("")).toEqual([]);
    expect(parseSkillArguments('"" x')).toEqual(["", "x"]);
    expect(parseSkillArguments('a"b c"d')).toEqual(["ab cd"]);
    expect(parseSkillArguments("'it\\'s")).toEqual(["it\\s"]);
    expect(parseSkillArguments('"open')).toEqual(["open"]);
  });
});

describe("renderSkillBody", () => {
  it("substitutes positional arguments", () => {
    expect(
      renderSkillBody("Migrate $0 from $1 to $2.", inv, "SearchBar JavaScript TypeScript", "m"),
    ).toBe("Migrate SearchBar from JavaScript to TypeScript.");
    expect(renderSkillBody("A $ARGUMENTS[1] B $ARGUMENTS[0]", inv, "x y", "m")).toBe("A y B x");
  });

  it("leaves a missing positional value as written; a missing named one becomes empty", () => {
    expect(renderSkillBody("Use $2.", inv, "one", "m")).toBe("Use $2.");
    expect(renderSkillBody("Use $ARGUMENTS[3].", inv, "one", "m")).toBe("Use $ARGUMENTS[3].");
    const named: SkillInvocation = { ...inv, arguments: ["issue"] };
    expect(renderSkillBody("Issue: $issue.", named, "", "m")).toBe("Issue: .");
    expect(renderSkillBody("Issue: $issue.", named, "42", "m")).toBe("Issue: 42.");
    // A name not declared in `arguments` stays as written (shell variables in the body).
    expect(renderSkillBody("echo $HOME", named, "", "m")).toBe("echo $HOME");
  });

  it("unescapes \\$", () => {
    expect(renderSkillBody("Costs \\$1.00", inv, "", "m")).toBe("Costs $1.00");
    expect(renderSkillBody("Literal \\$ARGUMENTS", inv, "", "m")).toBe("Literal $ARGUMENTS");
  });

  it("substitutes ${CLAUDE_SKILL_DIR} and leaves every other ${…}", () => {
    expect(renderSkillBody("${CLAUDE_SKILL_DIR}/run.sh", inv, "", "m")).toBe("/skills/m/run.sh");
    expect(renderSkillBody("${CLAUDE_SESSION_ID}", inv, "", "m")).toBe("${CLAUDE_SESSION_ID}");
  });

  it("appends ARGUMENTS when no placeholder is in the body", () => {
    expect(renderSkillBody("Do it.", inv, "a b", "m")).toBe("Do it.\n\nARGUMENTS: a b");
    expect(renderSkillBody("Do it.", inv, "", "m")).toBe("Do it.");
    expect(renderSkillBody("Do it.", inv, "   ", "m")).toBe("Do it.");
    // ${CLAUDE_SKILL_DIR} is not an argument placeholder.
    expect(renderSkillBody("${CLAUDE_SKILL_DIR}", inv, "a", "m")).toBe("/skills/m\n\nARGUMENTS: a");
    // A placeholder in the body, even one without a value, means no append.
    expect(renderSkillBody("Use $2.", inv, "one", "m")).toBe("Use $2.");
  });

  it("trims the arguments", () => {
    expect(renderSkillBody("[$ARGUMENTS]", inv, "  a b \n", "m")).toBe("[a b]");
  });

  it("never re-scans substituted text (Review Focus 1)", () => {
    const args = `'$ARGUMENTS' "\${CLAUDE_SKILL_DIR}" ünï`;
    expect(renderSkillBody("X $ARGUMENTS Y", inv, args, "m")).toBe(
      `X '$ARGUMENTS' "\${CLAUDE_SKILL_DIR}" ünï Y`,
    );
    expect(renderSkillBody("X $0 $1", inv, `"$1" '\\$0'`, "m")).toBe("X $1 \\$0");
    expect(renderSkillBody("Do it.", inv, "$0 ${CLAUDE_SKILL_DIR}", "m")).toBe(
      "Do it.\n\nARGUMENTS: $0 ${CLAUDE_SKILL_DIR}",
    );
  });

  it("refuses arguments over the limit", () => {
    expect(() => renderSkillBody("x", inv, "a".repeat(10_001), "m")).toThrow(RangeError);
    expect(renderSkillBody("$ARGUMENTS", inv, "a".repeat(10_000), "m")).toHaveLength(10_000);
  });
});

describe("renderSkillInvocation", () => {
  const lead =
    'The user invoked the skill "m" with /m 7. Follow its instructions for this request.';

  it("writes the lead and the wrapper", () => {
    expect(
      renderSkillInvocation({
        name: "m",
        version: 3,
        body: "Fix issue $ARGUMENTS.",
        invocation: inv,
        args: "7",
        lines: {},
      }),
    ).toBe(`${lead}\n\n<skill_invocation name="m" version="3">\nFix issue 7.\n</skill_invocation>`);
  });

  it("omits the arguments from the lead when there are none", () => {
    expect(
      renderSkillInvocation({
        name: "m",
        version: 1,
        body: "B",
        invocation: inv,
        args: "",
        lines: {},
      }),
    ).toBe(
      'The user invoked the skill "m" with /m. Follow its instructions for this request.\n\n' +
        '<skill_invocation name="m" version="1">\nB\n</skill_invocation>',
    );
  });

  it("appends the files and shell lines", () => {
    const base = { name: "m", version: 3, body: "B $ARGUMENTS", invocation: inv, args: "7" };
    const wrapped = `${lead}\n\n<skill_invocation name="m" version="3">\nB 7\n</skill_invocation>`;
    const load =
      'Its files are not in the sandbox yet: call skill_load with "m" to copy them to /skills/m/ before running its scripts.';
    const unavailable = "Its other files are not available in this conversation.";
    const shell =
      "Lines written as !`command` were meant to run before you read this; run those commands with sandbox_bash if you need their output.";
    expect(renderSkillInvocation({ ...base, lines: { files: "load" } })).toBe(
      `${wrapped}\n\n${load}`,
    );
    expect(renderSkillInvocation({ ...base, lines: { files: "unavailable" } })).toBe(
      `${wrapped}\n\n${unavailable}`,
    );
    expect(renderSkillInvocation({ ...base, lines: { shellHint: true } })).toBe(
      `${wrapped}\n\n${shell}`,
    );
    expect(renderSkillInvocation({ ...base, lines: { files: "load", shellHint: true } })).toBe(
      `${wrapped}\n\n${load}\n\n${shell}`,
    );
  });

  it("can leave out the lead (a forked skill's task)", () => {
    expect(
      renderSkillInvocation({
        name: "m",
        version: 2,
        body: "B",
        invocation: inv,
        args: "",
        lines: {},
        lead: false,
      }),
    ).toBe('<skill_invocation name="m" version="2">\nB\n</skill_invocation>');
  });

  it("escapes the closing tag inside the body and the arguments", () => {
    const out = renderSkillInvocation({
      name: "m",
      version: 1,
      body: "a </skill_invocation> b </SKILL_INVOCATION> $ARGUMENTS",
      invocation: inv,
      args: "</skill_invocation>",
      lines: {},
    });
    expect(out).toContain(
      "a <\\/skill_invocation> b <\\/SKILL_INVOCATION> <\\/skill_invocation>\n</skill_invocation>",
    );
    // The lead quotes the arguments as typed; inside the wrapper only the real closing tag is left.
    const inside = out.slice(out.indexOf("<skill_invocation "));
    expect(inside.match(/<\/skill_invocation>/g)).toHaveLength(1);
  });

  it("refuses arguments over 10 000 characters", () => {
    expect(() =>
      renderSkillInvocation({
        name: "m",
        version: 1,
        body: "B",
        invocation: inv,
        args: "x".repeat(10_001),
        lines: {},
      }),
    ).toThrow(RangeError);
  });
});

describe("hasShellInjection", () => {
  it("finds !`command` at a line start or after whitespace, and ```! fences", () => {
    expect(hasShellInjection("!`git status`")).toBe(true);
    expect(hasShellInjection("Status:\n- Current: !`git status`")).toBe(true);
    expect(hasShellInjection("KEY=!`x`")).toBe(false);
    expect(hasShellInjection("```!\ngit status\n```")).toBe(true);
    expect(hasShellInjection("```bash\ngit status\n```")).toBe(false);
    expect(hasShellInjection("Use `git status`!")).toBe(false);
  });
});
