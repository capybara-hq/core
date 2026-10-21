import { createHash } from "node:crypto";
import {
  type ObjectStore,
  parseSkillMd,
  SKILL_ENTRY_FILE,
  SKILLS_SANDBOX_ROOT,
  skillSandboxPath,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { EventLog } from "../../conversations/event-log.js";
import type { KernelDb, SkillManifest } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import type { CatalogSkill } from "../../runtime/context/skills.js";
import type { BuiltinCallContext, BuiltinTool } from "../registry.js";
import {
  clip,
  display,
  inSandbox,
  type SandboxSession,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  withNotices,
} from "./sandbox/common.js";

/**
 * 内置工具 `skill_load`（M5 T14，Ruling M17）：按日志里最新一份技能目录快照把名字解析为 id 与版本，返回该版本
 * SKILL.md 的正文与文件清单（结果里写明版本）。技能带其他文件时把整个技能复制进本对话沙箱的 `/skills/<name>/`
 * （提供方以 root 写，命令用户只读）；没有沙箱提供方时只给正文，并说明脚本不可用。
 *
 * - 存储里读出的每个文件都按清单的 sha256 核对，不符即拒绝（不把被替换的内容给模型或放进沙箱）。
 * - 复制记录在内核控制的标记文件 {@link SKILLS_MARKER}（`/skills` 下，命令用户改不了）：`{ <name>: { id, version,
 *   files, stale } }`。新建 / 重建的沙箱、版本变化、同名换了技能时重新复制，否则跳过。
 * - 可执行位：提供方写的文件一律不可执行（0644）。不扩展 `sandbox@1` 的 `writeFile`，而是在结果里告诉模型用解释器
 *   运行（`sh` / `python3` / `node`）：契约与两个提供方不变，技能包里的 shebang 脚本照样能跑，代价只是不能 `./x`。
 * - 旧版本多出的文件：`sandbox@1` 没有删除原语，命令用户也删不了 `/skills` 下的文件，所以新版本原地覆盖，
 *   旧版本独有的文件留在原处、记进标记的 `stale`，每次加载都在结果里列出「不属于当前版本、忽略它们」。
 */

/** 已复制进沙箱的技能的标记文件（内核控制：`/skills` 只有提供方以 root 能写；技能名不含 `.`，不会撞名）。 */
export const SKILLS_MARKER = `${SKILLS_SANDBOX_ROOT}/.capybara-skills.json`;
const MARKER_MAX_BYTES = 1024 * 1024;
/** 结果里最多列出的文件数（其余只给数量）。 */
const MAX_LISTED_FILES = 200;
/** 「不在目录里」的错误里最多列出的技能名。 */
const MAX_LISTED_NAMES = 50;

const SPEC: ToolSpec = {
  name: "skill_load",
  description:
    "Load a skill from the skills list in your instructions: returns the skill's instructions " +
    "(its SKILL.md) and the list of its files. Call it before starting a task that matches a " +
    "skill's description, then follow the returned instructions. If the skill has scripts or other " +
    "files, they are copied read-only to /skills/<name>/ in this conversation's sandbox; run scripts " +
    "there with an interpreter (sh, python3, node). Call it again when the skills list changes or " +
    "the sandbox was recreated. Do not use it for skills that are not in the list.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: 'The skill name exactly as listed, e.g. "pdf-report".',
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

// ---- 模型可见文案（英文） ----

const NO_SKILLS_TEXT =
  "No skills are available in this conversation; do the task without a skill, or ask the user to add one to this agent.";
const STORAGE_UNAVAILABLE_TEXT =
  "File storage is temporarily unavailable, so the skill's files cannot be read; retry later.";

const notInCatalog = (name: string, skills: readonly CatalogSkill[]): string => {
  const names = skills.slice(0, MAX_LISTED_NAMES).map((s) => s.name);
  const more = skills.length > names.length ? ", …" : "";
  return `Skill "${clip(name, 80)}" is not in the skills catalog for this conversation; call skill_load with one of the listed names: ${names.join(", ")}${more}.`;
};

const removedText = (name: string): string =>
  `Skill "${name}" was removed after the skills list was shown and can no longer be loaded; do the task without it, or ask the user to restore it.`;

const integrityText = (name: string): string =>
  `Skill "${name}" failed an integrity check (its stored files do not match the uploaded package); ask an administrator to upload the skill again.`;

/** 依赖：沙箱工具的依赖，加上读技能行用的库与读快照用的日志。 */
export interface SkillLoadDeps extends SandboxToolDeps {
  db: KernelDb;
  eventLog: Pick<EventLog, "append" | "latestOfType">;
}

/** 标记文件里一个技能的记录。 */
interface MarkerEntry {
  id: string;
  version: number;
  files: string[];
  /** 更早版本留下、不属于当前版本的文件。 */
  stale: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 解析标记文件；坏的按空处理（全部重新复制）。 */
function parseMarker(data: Uint8Array): Record<string, MarkerEntry> {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, MarkerEntry> = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      if (e === null || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.version !== "number") continue;
      out[k] = { id: r.id, version: r.version, files: strings(r.files), stale: strings(r.stale) };
    }
    return out;
  } catch {
    return {};
  }
}

/** 存储错误 → 给模型的说明（存储不可用可重试）；其余原样抛出。 */
function storageError(e: unknown): unknown {
  if (e instanceof ApiError && e.code === "storage.unavailable") {
    return new ToolError(STORAGE_UNAVAILABLE_TEXT);
  }
  return e;
}

/** 读一个技能文件并按清单核对大小与 sha256；对象不在或不符 → 完整性错误。 */
async function readVerified(
  store: ObjectStore,
  key: string,
  file: SkillManifest["files"][number],
  skill: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let got: Awaited<ReturnType<ObjectStore["get"]>>;
  try {
    got = await store.get(key, { signal });
  } catch (e) {
    throw storageError(e);
  }
  if (!got) throw new ToolError(integrityText(skill));
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = got.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > file.size) throw new ToolError(integrityText(skill));
      hash.update(value);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (n !== file.size || hash.digest("hex") !== file.sha256) {
    throw new ToolError(integrityText(skill));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** 本次加载的技能版本。 */
interface LoadedVersion {
  entry: CatalogSkill;
  manifest: SkillManifest;
  prefix: string;
  store: ObjectStore;
}

/**
 * 把技能整个复制到 `/skills/<name>/`（标记命中则跳过）。每个文件按清单核对后写入，全部写完才更新标记：
 * 中途失败下次整体重来。返回旧版本留下的文件。
 */
async function copySkill(s: SandboxSession, v: LoadedVersion): Promise<{ stale: string[] }> {
  const { name, id, version } = v.entry;
  let marker: Record<string, MarkerEntry> = {};
  if (!s.reset) {
    const m = await s.p.readFile(s.h, SKILLS_MARKER, {
      maxBytes: MARKER_MAX_BYTES,
      signal: s.signal,
    });
    if (m && !m.truncated) marker = parseMarker(m.data);
  }
  const cur = Object.hasOwn(marker, name) ? marker[name] : undefined;
  if (cur && cur.id === id && cur.version === version) return { stale: cur.stale };
  for (const f of v.manifest.files) {
    const data = await readVerified(v.store, `${v.prefix}${f.path}`, f, name, s.signal);
    await s.p.writeFile(s.h, skillSandboxPath(name, f.path), data, s.signal);
  }
  const files = v.manifest.files.map((f) => f.path);
  const now = new Set(files);
  const stale = cur ? [...new Set([...cur.stale, ...cur.files])].filter((p) => !now.has(p)) : [];
  stale.sort();
  const next = { ...marker, [name]: { id, version, files, stale } };
  await s.p.writeFile(s.h, SKILLS_MARKER, new TextEncoder().encode(JSON.stringify(next)), s.signal);
  return { stale };
}

/** 文件清单（最多 {@link MAX_LISTED_FILES} 行）。 */
function fileList(files: SkillManifest["files"]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `- ${f.path} (${f.size} bytes)`);
  if (files.length > shown.length) shown.push(`- … and ${files.length - shown.length} more files`);
  return shown.join("\n");
}

/** 内置工具 `skill_load`（见文件头）。 */
export function skillLoadTool(deps: SkillLoadDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    // 可能要创建 / 恢复沙箱并复制文件：与沙箱工具同一时限
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx: BuiltinCallContext) {
      const name = (input as { name: string }).name;
      const snap = await deps.eventLog.latestOfType(ctx.conversationId, "skills_catalog");
      const skills = snap?.payload.skills ?? [];
      if (skills.length === 0) throw new ToolError(NO_SKILLS_TEXT);
      const entry = skills.find((s) => s.name === name);
      if (!entry) throw new ToolError(notInCatalog(name, skills));

      const row = await deps.db
        .selectFrom("skills")
        .innerJoin("skill_versions", "skill_versions.skill_id", "skills.id")
        .select(["skills.deleted_at", "skill_versions.manifest", "skill_versions.object_prefix"])
        .where("skills.id", "=", entry.id)
        .where("skills.org_id", "=", ctx.orgId)
        .where("skill_versions.version", "=", entry.version)
        .executeTakeFirst();
      if (!row || row.deleted_at !== null) throw new ToolError(removedText(name));
      const manifest = row.manifest;
      const store = deps.storage.kernel(ctx.orgId);
      const v: LoadedVersion = { entry, manifest, prefix: row.object_prefix, store };

      const md = manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
      if (!md) throw new ToolError(integrityText(name));
      const mdBytes = await readVerified(store, `${v.prefix}${md.path}`, md, name, ctx.signal);
      let parsed: ReturnType<typeof parseSkillMd>;
      try {
        parsed = parseSkillMd(new TextDecoder("utf-8", { fatal: true }).decode(mdBytes));
      } catch {
        throw new ToolError(integrityText(name));
      }
      if ("errors" in parsed) throw new ToolError(integrityText(name));

      const dir = `${SKILLS_SANDBOX_ROOT}/${name}/`;
      const others = manifest.files.filter((f) => f.path !== SKILL_ENTRY_FILE);
      let notices: string[] = [];
      let filesText: string;
      if (others.length === 0) {
        filesText = "This skill has no files besides its instructions.";
      } else if (!deps.sandbox.available) {
        filesText =
          `Skill files (for reference):\n${fileList(manifest.files)}\n` +
          "This deployment has no sandbox, so the skill's scripts and other files are not available; " +
          "follow the instructions without running them.";
      } else {
        const r = await inSandbox(deps, ctx, (s) => copySkill(s, v));
        notices = r.notices;
        const stale =
          r.value.stale.length > 0
            ? `\nFiles left over from an earlier version (not part of this version; ignore them): ${r.value.stale.join(", ")}`
            : "";
        filesText =
          `Skill files (copied to ${dir} in the sandbox, read-only):\n${fileList(manifest.files)}\n` +
          `Run scripts with an interpreter, e.g. \`sh ${dir}<script>.sh\`, \`python3 ${dir}<script>.py\` ` +
          "or `node`; the files are not executable, so `./script` does not work. Write outputs under " +
          `/workspace, not ${SKILLS_SANDBOX_ROOT}.${stale}`;
      }
      const text = [
        `Loaded skill "${name}" (version ${entry.version}).`,
        filesText,
        `<skill name="${name}" version="${entry.version}">\n${parsed.body.trim()}\n</skill>`,
      ].join("\n\n");
      return {
        content: [{ type: "text", text: withNotices(notices, text) }],
        display: display(
          `加载技能 ${name}（版本 ${entry.version}）`,
          `Loaded skill ${name} (version ${entry.version})`,
        ),
      };
    },
  };
}
