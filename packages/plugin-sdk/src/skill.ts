/**
 * 技能（Agent Skills 格式）的纯解析与校验函数：内核上传技能包、agent 提议技能改动时都用它们。
 *
 * 格式依据（2026-10-21 核实）：
 * - Agent Skills 规范 https://agentskills.io/specification ：`name` 必填，1–64 个字符，只能是小写字母、数字与
 *   连字符，不能以连字符开头或结尾，不能有连续连字符，须与所在目录同名；`description` 必填，1–1024 个字符；
 *   可选 `license`、`compatibility`（1–500 个字符）、`metadata`、`allowed-tools`。
 * - Anthropic 文档 https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ：
 *   `name` 与 `description` 不能含 XML 标签（另有保留词 "anthropic" / "claude"，那是 Anthropic 平台自己的规则，
 *   这里不采用）。
 *
 * Choices: the description goes into the model's system prompt, so XML tags are refused as Anthropic
 * does (no forged prompt structure). Keys outside the specification are allowed and ignored, so
 * existing packages upload unchanged, except Claude Code's invocation keys
 * (`disable-model-invocation`, `user-invocable`, `context`, `agent`, `argument-hint`, `arguments`),
 * whose types are checked because the kernel uses them (`skillInvocation`, phase D). Matching the
 * directory name is not enforced: an uploaded zip's outer directory often has another name (GitHub's
 * `repo-main/`); the skill's name is always the frontmatter `name`, and its sandbox directory is
 * `/skills/<name>/`.
 */
import { readFrontmatter } from "./frontmatter.js";
import { hasControlChars } from "./model.js";
import { validateSandboxPath } from "./sandbox.js";
import { argumentHintText, SKILL_ARGUMENT_NAME_RE } from "./skill-keys.js";

/** 技能包的上限。 */
export const SKILL_LIMITS = {
  nameMaxChars: 64,
  descriptionMaxChars: 1024,
  compatibilityMaxChars: 500,
  /** 单个文件解压后的上限（字节）。 */
  fileBytes: 10 * 1024 * 1024,
  /** 全部文件解压后的总量上限（字节）。 */
  totalBytes: 50 * 1024 * 1024,
  /** 文件数上限。 */
  maxFiles: 1000,
  /** 包内相对路径的长度上限（字符）。 */
  pathMaxChars: 512,
  /** frontmatter（两条 `---` 之间）的长度上限（字符），超过不做 YAML 解析。 */
  frontmatterMaxChars: 64 * 1024,
} as const;

/** Limits of the invocation keys of a SKILL.md (see `SkillInvocation`). */
export const SKILL_INVOCATION_LIMITS = {
  /** `argument-hint`, in characters. */
  argumentHintMaxChars: 200,
  /** Names in `arguments`. */
  argumentNames: 20,
  /** The argument string of one invocation, in characters (after trimming). */
  argumentsMaxChars: 10_000,
} as const;

/** 技能入口文件（包根目录，大小写敏感）。 */
export const SKILL_ENTRY_FILE = "SKILL.md";

/** 沙箱里放技能的根目录：每个技能在 `/skills/<name>/` 下（只读复制）。 */
export const SKILLS_SANDBOX_ROOT = "/skills";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const XML_TAG_RE = /<\/?[A-Za-z][^<>]*>/;
const DRIVE_RE = /^[A-Za-z]:/;

/** 是否为合法的技能名（见文件头的规范说明）。 */
export function isSkillName(s: unknown): s is string {
  return typeof s === "string" && s.length <= SKILL_LIMITS.nameMaxChars && NAME_RE.test(s);
}

/** 技能文件在沙箱里的路径：`/skills/<name>/<path>`。 */
export function skillSandboxPath(name: string, path: string): string {
  return `${SKILLS_SANDBOX_ROOT}/${name}/${path}`;
}

/** {@link parseSkillMd} 成功时的结果。 */
export interface ParsedSkillMd {
  name: string;
  /** 去掉首尾空白。 */
  description: string;
  /** frontmatter 之后的 Markdown 正文。 */
  body: string;
  /**
   * The parsed YAML frontmatter mapping: every key, values unchanged (e.g. Claude Code's
   * `disable-model-invocation`, `context`, `allowed-tools`), for readers that translate them.
   */
  frontmatter: Readonly<Record<string, unknown>>;
}

/** Options of {@link parseSkillMd}. */
export interface ParseSkillMdOptions {
  /**
   * false: do not check the types of the invocation keys (`disable-model-invocation`, `context`,
   * ...). For readers of a SKILL.md stored before those checks existed, which must keep loading;
   * `skillInvocation` ignores values of the wrong type. Default true.
   */
  invocationKeys?: boolean;
}

const chars = (s: string) => [...s].length;

/**
 * 解析 SKILL.md：开头是 `---` 行包住的 YAML frontmatter，之后是正文。容忍 BOM 与 CRLF（正文里的 CRLF 换成 LF）。
 * 返回 name / description / 正文，或全部问题（英文，可直接给模型或管理员看）。
 */
export function parseSkillMd(
  text: string,
  options: ParseSkillMdOptions = {},
): ParsedSkillMd | { errors: string[] } {
  const read = readFrontmatter(text, "SKILL.md", SKILL_LIMITS.frontmatterMaxChars);
  if ("errors" in read) return read;
  const { frontmatter: fm, body } = read;
  const errors: string[] = [];

  const name = fm.name;
  if (name === undefined || name === null) errors.push("name is required");
  else if (typeof name !== "string") errors.push("name must be a string");
  else if (!isSkillName(name)) {
    errors.push(
      "name must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen",
    );
  }

  const rawDesc = fm.description;
  let description = "";
  if (rawDesc === undefined || rawDesc === null) errors.push("description is required");
  else if (typeof rawDesc !== "string") errors.push("description must be a string");
  else {
    description = rawDesc.trim();
    if (description === "") errors.push("description must not be empty");
    else if (chars(description) > SKILL_LIMITS.descriptionMaxChars) {
      errors.push(`description must be at most ${SKILL_LIMITS.descriptionMaxChars} characters`);
    } else if (XML_TAG_RE.test(description)) {
      errors.push("description must not contain XML tags");
    }
  }

  const compat = fm.compatibility;
  if (
    compat !== undefined &&
    (typeof compat !== "string" ||
      compat.length === 0 ||
      chars(compat) > SKILL_LIMITS.compatibilityMaxChars)
  ) {
    errors.push(
      `compatibility must be a string of 1-${SKILL_LIMITS.compatibilityMaxChars} characters`,
    );
  }

  if (options.invocationKeys !== false) errors.push(...invocationKeyErrors(fm));

  if (errors.length > 0) return { errors };
  return { name: name as string, description, body, frontmatter: fm };
}

const AGENT_MAX_CHARS = 130;

/** The type errors of the invocation keys (`disable-model-invocation`, `context`, ...). */
function invocationKeyErrors(fm: Readonly<Record<string, unknown>>): string[] {
  const errors: string[] = [];
  const dmi = fm["disable-model-invocation"];
  if (dmi !== undefined && typeof dmi !== "boolean") {
    errors.push("disable-model-invocation must be a boolean");
  }
  const ui = fm["user-invocable"];
  if (ui !== undefined && typeof ui !== "boolean") errors.push("user-invocable must be a boolean");
  if (fm.context !== undefined && fm.context !== "fork") errors.push('context must be "fork"');
  const agent = fm.agent;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || agent === "" || chars(agent) > AGENT_MAX_CHARS)
  ) {
    errors.push(`agent must be a string of 1-${AGENT_MAX_CHARS} characters`);
  }
  const hint = fm["argument-hint"];
  if (hint !== undefined) {
    const text = argumentHintText(hint);
    if (text === undefined || chars(text) > SKILL_INVOCATION_LIMITS.argumentHintMaxChars) {
      errors.push(
        `argument-hint must be a string of at most ${SKILL_INVOCATION_LIMITS.argumentHintMaxChars} characters`,
      );
    }
  }
  const names = fm.arguments;
  if (
    names !== undefined &&
    (!Array.isArray(names) ||
      names.length > SKILL_INVOCATION_LIMITS.argumentNames ||
      !names.every((n) => typeof n === "string" && SKILL_ARGUMENT_NAME_RE.test(n)))
  ) {
    errors.push(
      `arguments must be a list of at most ${SKILL_INVOCATION_LIMITS.argumentNames} names`,
    );
  }
  if (dmi === true && ui === false) {
    errors.push(
      "a skill with disable-model-invocation: true and user-invocable: false cannot be used",
    );
  }
  return errors;
}

/** 给人看的路径：含控制字符时用 JSON 转义。 */
const show = (p: string) => (hasControlChars(p) || p === "" ? JSON.stringify(p) : p);

/** 单个相对路径的问题（第一个），合法时为 null。 */
function pathProblem(p: unknown): string | null {
  if (typeof p !== "string" || p === "") return "path must be a non-empty string";
  if (chars(p) > SKILL_LIMITS.pathMaxChars) {
    return `path must be at most ${SKILL_LIMITS.pathMaxChars} characters`;
  }
  if (hasControlChars(p)) return "path must not contain control characters";
  if (p.includes("\\")) return "path must not contain backslashes";
  if (p.startsWith("/")) return "path must be relative";
  if (DRIVE_RE.test(p)) return "path must not start with a drive letter";
  if (p.endsWith("/")) return "path must name a file, not a directory";
  for (const seg of p.split("/")) {
    if (seg === "") return "path must not contain empty segments";
    if (seg === "." || seg === "..") return "path must not contain '.' or '..' segments";
  }
  // 再按沙箱路径规则核一遍（百分号编码的 `..` 等）
  const errs = validateSandboxPath(skillSandboxPath("skill", p));
  return errs[0] ?? null;
}

/**
 * 校验技能包的文件清单（路径相对于包根目录，只含文件、不含目录项）：
 * 根目录必须有 `SKILL.md`；单文件 ≤ {@link SKILL_LIMITS.fileBytes}；总量 ≤ {@link SKILL_LIMITS.totalBytes}；
 * 文件数 ≤ {@link SKILL_LIMITS.maxFiles}；路径不能越界（绝对路径、`..`、反斜杠、盘符、控制字符），不能重复
 * （只差大小写也算重复：大小写不敏感的文件系统上会互相覆盖），文件不能与目录同名。返回问题列表，空数组表示合法。
 */
export function validateSkillPackage(files: { path: string; size: number }[]): string[] {
  if (files.length > SKILL_LIMITS.maxFiles) {
    return [`package has more than ${SKILL_LIMITS.maxFiles} files`];
  }
  const errors: string[] = [];
  if (!files.some((f) => f.path === SKILL_ENTRY_FILE)) {
    errors.push(`${SKILL_ENTRY_FILE} is required at the root`);
  }
  const exact = new Set<string>();
  const folded = new Set<string>();
  const fileKeys = new Set<string>();
  const dirKeys = new Set<string>();
  let total = 0;
  for (const f of files) {
    const p = f.path;
    const problem = pathProblem(p);
    if (problem) {
      errors.push(`${show(String(p))}: ${problem}`);
      continue;
    }
    if (!Number.isSafeInteger(f.size) || f.size < 0) {
      errors.push(`${show(p)}: size must be a non-negative integer`);
      continue;
    }
    if (f.size > SKILL_LIMITS.fileBytes) {
      errors.push(`${show(p)}: file is larger than ${SKILL_LIMITS.fileBytes} bytes`);
    }
    total += f.size;
    const key = p.normalize("NFC").toLowerCase();
    if (exact.has(p)) {
      errors.push(`${show(p)}: duplicate path`);
      continue;
    }
    exact.add(p);
    if (folded.has(key)) {
      errors.push(`${show(p)}: duplicate path (paths differ only in letter case)`);
      continue;
    }
    folded.add(key);
    const segs = key.split("/");
    const parents = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
    if (dirKeys.has(key) || parents.some((d) => fileKeys.has(d))) {
      errors.push(`${show(p)}: a file and a directory have the same path`);
      continue;
    }
    fileKeys.add(key);
    for (const d of parents) dirKeys.add(d);
  }
  if (total > SKILL_LIMITS.totalBytes) {
    errors.push(`package is larger than ${SKILL_LIMITS.totalBytes} bytes in total`);
  }
  return errors;
}
