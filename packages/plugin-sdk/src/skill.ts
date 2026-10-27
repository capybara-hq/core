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
 * 取舍：description 会进模型的系统提示，所以照 Anthropic 的规则拒绝 XML 标签（防止伪造提示结构）；
 * 规范之外的键（如 Claude Code 的 `argument-hint`、`disable-model-invocation`）一律允许并忽略，
 * 已有的技能包不用改就能上传。「与所在目录同名」不强制：上传的 zip 外层目录常是别的名字（如 GitHub 的
 * `repo-main/`），技能名一律取 frontmatter 的 name，沙箱里的目录就是 `/skills/<name>/`。
 */
import { readFrontmatter } from "./frontmatter.js";
import { hasControlChars } from "./model.js";
import { validateSandboxPath } from "./sandbox.js";

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

const chars = (s: string) => [...s].length;

/**
 * 解析 SKILL.md：开头是 `---` 行包住的 YAML frontmatter，之后是正文。容忍 BOM 与 CRLF（正文里的 CRLF 换成 LF）。
 * 返回 name / description / 正文，或全部问题（英文，可直接给模型或管理员看）。
 */
export function parseSkillMd(text: string): ParsedSkillMd | { errors: string[] } {
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

  if (errors.length > 0) return { errors };
  return { name: name as string, description, body, frontmatter: fm };
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
