// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code variables such as ${CLAUDE_SKILL_DIR} are plain text here
/**
 * Manual skill invocation (package ecosystem phase D): a skill's invocation metadata read from its
 * SKILL.md frontmatter, and the pure rendering of `/name args` into the text the model sees.
 *
 * The argument rules follow Claude Code (re-checked 2026-10-27): `$ARGUMENTS` is the whole argument
 * string, `$ARGUMENTS[N]` / `$N` are 0-based positional values (a missing one stays as written),
 * `$name` takes its value from frontmatter `arguments` (a missing one becomes empty), `\$` is a
 * literal `$`, `${CLAUDE_SKILL_DIR}` is `/skills/<name>` and every other `${…}` stays as written.
 * When the body has no argument placeholder and the arguments are not empty, they are appended as
 * `ARGUMENTS: <args>`. Substituted text is never scanned again. Nothing is executed: shell
 * injections (`` !`cmd` ``) stay text, and the model is told how to run them.
 */
import { isSkillName, SKILL_INVOCATION_LIMITS, SKILLS_SANDBOX_ROOT } from "./skill.js";
import { argumentHintText, SKILL_ARGUMENT_NAME_RE } from "./skill-keys.js";

/** How a skill can be invoked, read from its SKILL.md frontmatter by {@link skillInvocation}. */
export interface SkillInvocation {
  /** false: `disable-model-invocation: true` (manual-only, left out of the model's catalog). */
  model: boolean;
  /** false: `user-invocable: false` (hidden from the `/` menu). */
  user: boolean;
  /** `context: fork`: runs as a sub-agent when a person invokes it; `agent` as written. */
  fork?: { agent?: string };
  /** `argument-hint`, shown after the skill's name in the `/` menu. */
  argumentHint?: string;
  /** `arguments`: the names usable as `$name` in the body, in positional order. */
  arguments?: string[];
}

/**
 * The invocation metadata of a SKILL.md frontmatter. Values of the wrong type are ignored here
 * (`parseSkillMd` reports them as errors), so this never throws.
 */
export function skillInvocation(frontmatter: Readonly<Record<string, unknown>>): SkillInvocation {
  const out: SkillInvocation = {
    model: frontmatter["disable-model-invocation"] !== true,
    user: frontmatter["user-invocable"] !== false,
  };
  if (frontmatter.context === "fork") {
    const agent = frontmatter.agent;
    out.fork = typeof agent === "string" && agent !== "" ? { agent } : {};
  }
  const hint = argumentHintText(frontmatter["argument-hint"]);
  if (hint !== undefined && hint !== "") out.argumentHint = hint;
  const names = frontmatter.arguments;
  if (
    Array.isArray(names) &&
    names.length > 0 &&
    names.every((n) => typeof n === "string" && SKILL_ARGUMENT_NAME_RE.test(n))
  ) {
    out.arguments = [...names];
  }
  return out;
}

/**
 * Splits an argument string like a shell: whitespace separates values, double and single quotes
 * group (`"hello world"` is one value), a backslash outside single quotes escapes the next
 * character (inside double quotes only `"` and `\`). An unclosed quote runs to the end.
 */
export function parseSkillArguments(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const s = [...args];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const PLACEHOLDER_RE =
  /\\\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{CLAUDE_SKILL_DIR\}/g;

const trimmedArgs = (args: string): string => {
  const t = args.trim();
  if ([...t].length > SKILL_INVOCATION_LIMITS.argumentsMaxChars) {
    throw new RangeError(
      `skill arguments must be at most ${SKILL_INVOCATION_LIMITS.argumentsMaxChars} characters`,
    );
  }
  return t;
};

const checkSkillName = (skillName: string): void => {
  if (!isSkillName(skillName)) {
    throw new TypeError(
      `skillName must be a bare skill name (its directory under ${SKILLS_SANDBOX_ROOT}), got "${skillName}"`,
    );
  }
};

const tooLong = (): RangeError =>
  new RangeError(
    `the rendered skill must be at most ${SKILL_INVOCATION_LIMITS.renderedMaxChars} characters`,
  );

/**
 * A skill body with its arguments substituted (see the file header), without the wrapper.
 * `skillName` is the resolved skill's bare name: `${CLAUDE_SKILL_DIR}` becomes
 * `/skills/<skillName>` (a qualified `<plugin>:<name>` throws a `TypeError`). `args` is trimmed;
 * more than {@link SKILL_INVOCATION_LIMITS.argumentsMaxChars} characters throw a `RangeError`, and
 * so does a result longer than {@link SKILL_INVOCATION_LIMITS.renderedMaxChars} (checked while
 * substituting, before the long string is built).
 */
export function renderSkillBody(
  body: string,
  invocation: SkillInvocation,
  args: string,
  skillName: string,
): string {
  checkSkillName(skillName);
  const all = trimmedArgs(args);
  const values = parseSkillArguments(all);
  const named = invocation.arguments ?? [];
  const max = SKILL_INVOCATION_LIMITS.renderedMaxChars;
  let placeholder = false;
  // Output length so far = body consumed up to the match end, minus the matched text, plus what
  // replaced it.
  let delta = 0;
  const replace = (m: string, idx?: string, pos?: string, word?: string): string => {
    if (m === "\\$") return "$";
    if (m === "${CLAUDE_SKILL_DIR}") return `${SKILLS_SANDBOX_ROOT}/${skillName}`;
    if (m === "$ARGUMENTS") {
      placeholder = true;
      return all;
    }
    const n = idx ?? pos;
    if (n !== undefined) {
      placeholder = true;
      return values[Number(n)] ?? m;
    }
    const at = word === undefined ? -1 : named.indexOf(word);
    if (at < 0) return m;
    placeholder = true;
    return values[at] ?? "";
  };
  const out = body.replace(
    PLACEHOLDER_RE,
    (
      m: string,
      idx: string | undefined,
      pos: string | undefined,
      word: string | undefined,
      offset: number,
    ) => {
      const r = replace(m, idx, pos, word);
      delta += r.length - m.length;
      if (offset + m.length + delta > max) throw tooLong();
      return r;
    },
  );
  const result = !placeholder && all !== "" ? `${out}\n\nARGUMENTS: ${all}` : out;
  if (result.length > max) throw tooLong();
  return result;
}

/** Input of {@link renderSkillInvocation}. */
export interface RenderSkillInvocationInput {
  /**
   * The name the person typed after `/` (`fix-issue`, or `<plugin>:<name>`): used in the lead, the
   * `name="…"` attribute and the `skill_load` argument (where the qualified form resolves).
   */
  name: string;
  /**
   * The resolved skill's bare name (never `<plugin>:<name>`): its sandbox directory
   * `/skills/<skillName>/`, used for `${CLAUDE_SKILL_DIR}` and the files line.
   */
  skillName: string;
  version: number;
  /** The SKILL.md body (after the frontmatter). */
  body: string;
  invocation: SkillInvocation;
  /** The text after `/name`. */
  args: string;
  /** Decided by the caller from the agent's tools and the version's manifest. */
  lines: {
    /** The version has files besides SKILL.md: `load` when the agent has `skill_load`. */
    files?: "load" | "unavailable";
    /** The body has shell injections and the agent has `sandbox_bash`. */
    shellHint?: boolean;
  };
  /** false: leave out the lead sentence (a forked skill's task for the sub-agent). Default true. */
  lead?: boolean;
}

const CLOSE_TAG_RE = /<\/(skill_invocation)/gi;
const OPEN_TAG_RE = /<(skill_invocation)/gi;

/** Both wrapper tags made inert, for text outside the wrapper (the lead). */
const escapeTags = (s: string): string =>
  s.replace(CLOSE_TAG_RE, "<\\/$1").replace(OPEN_TAG_RE, "<\\$1");

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The model-visible text of an inline skill invocation: the lead sentence, the rendered body inside
 * `<skill_invocation name="…" version="…">`, then the optional files and shell lines. A closing
 * tag inside the body is written `<\/skill_invocation` so the wrapper cannot be closed early; in the
 * lead (which quotes the arguments as typed) both tags are made inert (`<\/skill_invocation`,
 * `<\skill_invocation`), and the `name` attribute escapes `&`, `"` and `<`. Throws like
 * {@link renderSkillBody}.
 */
export function renderSkillInvocation(i: RenderSkillInvocationInput): string {
  const args = trimmedArgs(i.args);
  const body = renderSkillBody(i.body, i.invocation, args, i.skillName).replace(
    CLOSE_TAG_RE,
    "<\\/$1",
  );
  const parts: string[] = [];
  if (i.lead !== false) {
    parts.push(
      escapeTags(
        `The user invoked the skill "${i.name}" with /${i.name}${args === "" ? "" : ` ${args}`}. Follow its instructions for this request.`,
      ),
    );
  }
  parts.push(
    `<skill_invocation name="${escapeAttr(i.name)}" version="${i.version}">\n${body}\n</skill_invocation>`,
  );
  if (i.lines.files === "load") {
    parts.push(
      `Its files are not in the sandbox yet: call skill_load with "${i.name}" to copy them to ${SKILLS_SANDBOX_ROOT}/${i.skillName}/ before running its scripts.`,
    );
  } else if (i.lines.files === "unavailable") {
    parts.push("Its other files are not available in this conversation.");
  }
  if (i.lines.shellHint) {
    parts.push(
      "Lines written as !`command` were meant to run before you read this; run those commands with sandbox_bash if you need their output.",
    );
  }
  return parts.join("\n\n");
}

const INLINE_SHELL_RE = /(?:^|[ \t])!`[^`\n]+`/m;
const FENCE_SHELL_RE = /^[ \t]*```!/m;

/**
 * Whether a skill body has Claude Code shell injections: `` !`command` `` at the start of a line or
 * after whitespace, or a fenced block opened with ` ```! `.
 */
export function hasShellInjection(body: string): boolean {
  return INLINE_SHELL_RE.test(body) || FENCE_SHELL_RE.test(body);
}
