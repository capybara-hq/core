import { createHash } from "node:crypto";
import {
  isSkillName,
  parseSkillMd,
  SKILL_ENTRY_FILE,
  SKILL_LIMITS,
  ToolError,
  type ToolSpec,
  validateSkillPackage,
} from "@capybara-hq/plugin-sdk";
import { stringify as stringifyYaml } from "yaml";
import type { SkillManifest } from "../../db/kernel-schema.js";
import type { SkillChangesService } from "../../skills/changes.service.js";
import type { BuiltinCallContext, BuiltinTool } from "../registry.js";
import { display } from "./sandbox/common.js";

/**
 * 内置工具 `skill_write`（M5 T15，R4）：agent 新建或更新它自己的技能（`scope = agent`）。
 * - 输入 `{ name, description, files: [{ path, content }] }`，只收文本文件，整个技能 ≤ {@link SKILL_WRITE_MAX_BYTES}；
 * - SKILL.md 由内核合成（{@link buildSkillWrite}）：frontmatter 取 `name` / `description`，正文取 `files` 里
 *   `SKILL.md` 一项的内容（其中自带的 frontmatter 丢弃）；没有这一项时正文为空；
 * - 每次调用写一个完整的新版本（上一版有、这次没给的文件不再属于新版本）；
 * - 私有 agent 直接生成新版本并立即生效；共享 agent 由触发对话的人先确认这次调用（R3 固定 ask，见 tools/policy.ts），
 *   再生成变更申请等负责人批准，期间只有本对话试用新版本（见 skills/changes.service.ts）；
 * - 成功后立即在日志追加技能目录快照（`skills_catalog`，Ruling M17），同一运行的下一步就能 `skill_load`。
 */

/** 一个技能（含合成的 SKILL.md）的总大小上限（UTF-8 字节）。 */
export const SKILL_WRITE_MAX_BYTES = 1024 * 1024;
/** 一次最多的文件数（含 SKILL.md）。 */
export const SKILL_WRITE_MAX_FILES = 200;

const SPEC: ToolSpec = {
  name: "skill_write",
  description:
    "Create or update one of this agent's own skills: reusable instructions plus optional text files " +
    "(scripts, templates, reference notes) that you or later conversations can load with skill_load. " +
    "Each call writes a complete new version. SKILL.md is generated for you: its frontmatter comes from " +
    "`name` and `description`, and its body is the content of the `SKILL.md` entry in `files` if you " +
    "include one (any frontmatter in that entry is dropped). Every other entry in `files` is stored at " +
    "/skills/<name>/<path>. Files of the previous version that you leave out are not part of the new " +
    "version. Text files only, at most 1 MB per skill in total. Use an existing skill's name to update " +
    "it; an organization skill with the same name is shadowed by this agent's own skill. On a private " +
    "agent the new version takes effect immediately. On a shared agent the change is sent to the " +
    "agent's owner for approval and is usable only in this conversation until approved.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: SKILL_LIMITS.nameMaxChars,
        description:
          'Skill name: lowercase letters, digits and single hyphens, e.g. "weekly-report". Also the folder name under /skills/.',
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: SKILL_LIMITS.descriptionMaxChars,
        description:
          "What the skill does and when to use it, in one or two sentences (shown in the skills list). No XML tags.",
      },
      files: {
        type: "array",
        maxItems: SKILL_WRITE_MAX_FILES,
        description:
          'The skill\'s files. Include {"path": "SKILL.md", "content": "<instructions in Markdown>"} for the body; other paths are relative, e.g. "scripts/build.sh".',
        items: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: SKILL_LIMITS.pathMaxChars },
            content: { type: "string", description: "The full text content of the file." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "description", "files"],
    additionalProperties: false,
  },
};

/** `skill_write` 的输入（已按 inputSchema 校验）。 */
export interface SkillWriteInput {
  name: string;
  description: string;
  files: { path: string; content: string }[];
}

/** 一个待写入的文件。 */
export interface BuiltSkillFile {
  path: string;
  data: Uint8Array;
  size: number;
  sha256: string;
}

/** {@link buildSkillWrite} 成功的结果。 */
export interface BuiltSkill {
  name: string;
  description: string;
  files: BuiltSkillFile[];
  manifest: SkillManifest;
}

/** 去掉开头的 YAML frontmatter（与 `parseSkillMd` 同一判定：首行 `---`、之后某行 `---`）；没有则原样。 */
function stripFrontmatter(text: string): string {
  const src = (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  if (lines[0]?.trimEnd() !== "---") return src;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return src;
  return lines.slice(end + 1).join("\n");
}

const enc = new TextEncoder();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * 由工具输入合成技能文件（纯函数）：
 * - SKILL.md = `---\n<yaml name/description>---\n\n<正文>\n`，正文为 `files` 里 `SKILL.md` 的内容去掉 frontmatter、
 *   去掉首尾空行；合成结果再用 `parseSkillMd` 校验（名字规则、描述长度、不含 XML 标签）；
 * - 其余文件按 `validateSkillPackage` 校验路径（不能越出 `/skills/<name>/`、不能重复、大小写冲突等）；
 * - 只收文本：内容含 NUL 视为二进制，拒绝；全部文件（含 SKILL.md）的 UTF-8 字节数之和 ≤ {@link SKILL_WRITE_MAX_BYTES}。
 * 返回合成结果或全部问题（英文，直接给模型）。
 */
export function buildSkillWrite(input: SkillWriteInput): BuiltSkill | { errors: string[] } {
  const errors: string[] = [];
  if (!isSkillName(input.name)) {
    errors.push(
      `name "${String(input.name).slice(0, 80)}" is invalid: use 1-64 lowercase letters, digits and single hyphens (no leading or trailing hyphen)`,
    );
  }
  const entries = input.files.filter((f) => f.path === SKILL_ENTRY_FILE);
  if (entries.length > 1) errors.push(`${SKILL_ENTRY_FILE}: duplicate path`);
  const body = stripFrontmatter(entries[0]?.content ?? "").replace(/^\n+|\s+$/g, "");
  const front = stringifyYaml(
    { name: input.name, description: input.description.trim() },
    { lineWidth: 0 },
  );
  const md = `---\n${front}---\n${body === "" ? "" : `\n${body}\n`}`;
  if (errors.length === 0) {
    const parsed = parseSkillMd(md);
    if ("errors" in parsed) errors.push(...parsed.errors);
  }
  const others = input.files.filter((f) => f.path !== SKILL_ENTRY_FILE);
  const files: BuiltSkillFile[] = [];
  const mdData = enc.encode(md);
  files.push({
    path: SKILL_ENTRY_FILE,
    data: mdData,
    size: mdData.byteLength,
    sha256: sha256(mdData),
  });
  for (const f of others) {
    if (f.content.includes("\u0000")) {
      errors.push(
        `${f.path.slice(0, 200)}: only text files are supported (the content contains NUL bytes)`,
      );
      continue;
    }
    const data = enc.encode(f.content);
    files.push({ path: f.path, data, size: data.byteLength, sha256: sha256(data) });
  }
  errors.push(...validateSkillPackage(files.map((f) => ({ path: f.path, size: f.size }))));
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > SKILL_WRITE_MAX_BYTES) {
    errors.push(
      `the skill is ${total} bytes in total, over the 1 MB (${SKILL_WRITE_MAX_BYTES} bytes) limit; shorten the files or move large data out of the skill`,
    );
  }
  if (errors.length > 0) return { errors };
  const description = input.description.trim();
  return {
    name: input.name,
    description,
    files,
    manifest: {
      name: input.name,
      description,
      files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    },
  };
}

/** 依赖：技能变更服务。 */
export interface SkillWriteDeps {
  changes: Pick<SkillChangesService, "write">;
}

/** 内置工具 `skill_write`（见文件头）。 */
export function skillWriteTool(deps: SkillWriteDeps): BuiltinTool {
  return {
    spec: SPEC,
    // 私有 agent 不询问；共享 agent 由 R3 固定 ask 把关（tools/policy.ts 的 R3_SHARED_AGENT_ONLY_TOOL_KEYS）
    defaultPolicy: "allow",
    async run(input, ctx: BuiltinCallContext) {
      const built = buildSkillWrite(input as SkillWriteInput);
      if ("errors" in built) {
        throw new ToolError(
          `The skill was not written. Fix these problems and call skill_write again:\n- ${built.errors.slice(0, 20).join("\n- ")}`,
        );
      }
      const r = await deps.changes.write(
        {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          ...(ctx.runId !== undefined && { runId: ctx.runId }),
        },
        built,
      );
      const name = built.name;
      if (r.kind === "version") {
        const what = r.created ? "Created" : "Updated";
        return {
          content: [
            {
              type: "text",
              text:
                `${what} skill "${name}" (version ${r.version}, ${built.files.length} files). ` +
                "It is in effect now for every conversation with this agent; call skill_load to use it.",
            },
          ],
          display: display(
            `${r.created ? "新建" : "更新"}技能 ${name}（版本 ${r.version}）`,
            `${what} skill ${name} (version ${r.version})`,
          ),
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Saved skill "${name}" (version ${r.version}, ${built.files.length} files) as a change ` +
              "awaiting the owner's approval, because this agent is shared. Until the owner approves it, " +
              "the new version is usable only in this conversation (call skill_load to use it); other " +
              "conversations keep the current version. Tell the user the change needs the owner's approval.",
          },
        ],
        display: display(
          `技能 ${name} 的改动（版本 ${r.version}）已提交，等待负责人批准`,
          `Change to skill ${name} (version ${r.version}) awaits the owner's approval`,
        ),
      };
    },
  };
}
