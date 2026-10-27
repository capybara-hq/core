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
import { sql } from "kysely";
import { type AgentDefinition, normalizeStoredDefinition } from "../../agents/definition.js";
import type { EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent } from "../../conversations/events.js";
import type { KernelDb, SkillManifest } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import { type CatalogSkill, latestInvocation } from "../../runtime/context/skills.js";
import { dispatchOfChildRun } from "../../runtime/subagents/child.js";
import { resolveSkillForkType } from "../../runtime/subagents/roster.js";
import { invocationOf, resolveSkills } from "../../skills/catalog.js";
import type { BuiltinCallContext, BuiltinTool } from "../registry.js";
import {
  clip,
  display,
  inSandbox,
  type SandboxSession,
  type SandboxToolDeps,
  sandboxBaseTimeoutMs,
  withNotices,
  withPathLease,
} from "./sandbox/common.js";
import { SANDBOX_TOOL_NAMES } from "./sandbox/names.js";

/**
 * 内置工具 `skill_load`（M5 T14，Ruling M17）：按日志里最新一份技能目录快照把名字解析为 id 与版本，返回该版本
 * SKILL.md 的正文与文件清单（结果里写明版本）。技能带其他文件时把整个技能复制进本对话沙箱的 `/skills/<name>/`
 * （提供方以 root 写，命令用户只读）；没有沙箱提供方时只给正文，并说明脚本不可用。
 *
 * - 存储里读出的每个文件都按清单的 sha256 核对，不符即拒绝（不把被替换的内容给模型或放进沙箱）。
 * - 复制记录在内核控制的标记文件（每个技能一个，{@link skillMarkerPath}：`/skills/.capybara/<name>.json`，
 *   命令用户改不了）：`{ id, version, prefix, files, stale }`。新建 / 重建的沙箱、版本或来源前缀变化、同名换了技能时
 *   重新复制，否则跳过。
 * - agent 没有任何沙箱工具时不创建沙箱、不复制（模型也跑不了脚本），只给正文并说明。
 * - 可执行位：提供方写的文件一律不可执行（0644）。不扩展 `sandbox@1` 的 `writeFile`，而是在结果里告诉模型用解释器
 *   运行（`sh` / `python3` / `node`）：契约与两个提供方不变，技能包里的 shebang 脚本照样能跑，代价只是不能 `./x`。
 * - 旧版本多出的文件：`sandbox@1` 没有删除原语，命令用户也删不了 `/skills` 下的文件，所以新版本原地覆盖，
 *   旧版本独有的文件留在原处、记进标记的 `stale`，每次加载都在结果里列出「不属于当前版本、忽略它们」。
 */

/**
 * 已复制进沙箱的技能的标记目录（内核控制：`/skills` 只有提供方以 root 能写；技能名不以 `.` 开头，不会撞名）。
 */
export const SKILLS_MARKER_DIR = `${SKILLS_SANDBOX_ROOT}/.capybara`;
/** 一个技能的标记文件。 */
export const skillMarkerPath = (name: string): string => `${SKILLS_MARKER_DIR}/${name}.json`;
const MARKER_MAX_BYTES = 256 * 1024;
/** 结果里最多列出的文件数（其余只给数量）。 */
const MAX_LISTED_FILES = 200;
/** 「不在目录里」的错误里最多列出的技能名。 */
const MAX_LISTED_NAMES = 50;

const SPEC: ToolSpec = {
  name: "skill_load",
  // Display only (the tool row; not in the fingerprint, never sent to the model).
  keyArgs: ["name"],
  description:
    "Load a skill from the skills list: returns the skill's instructions " +
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

/** Phase D spec §4.4: the line before a forked skill's instructions (model-visible, English). */
const forkAvailableText = (type: string): string =>
  `This skill is written to run in a sub-agent: call agent with subagent_type "${type}" and a prompt containing these instructions and the details of the task, then use its report; do not follow the instructions yourself.`;
const FORK_UNAVAILABLE_TEXT =
  "This skill is written to run in a sub-agent, which is not available here; follow the instructions yourself.";

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
  /**
   * 复制来源的对象前缀：版本号相同但内容不同（被拒绝的试用草稿与之后的新草稿同号，T15）时据此重新复制。
   * 旧标记没有这一项，按不一致处理（重新复制一次）。
   */
  prefix?: string;
  files: string[];
  /** 更早版本留下、不属于当前版本的文件。 */
  stale: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 解析一个技能的标记文件；坏的按没有处理（重新复制）。 */
function parseMarker(data: Uint8Array): MarkerEntry | undefined {
  try {
    const r = JSON.parse(new TextDecoder().decode(data)) as unknown;
    if (r === null || typeof r !== "object" || Array.isArray(r)) return undefined;
    const e = r as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.version !== "number") return undefined;
    return {
      id: e.id,
      version: e.version,
      ...(typeof e.prefix === "string" && { prefix: e.prefix }),
      files: strings(e.files),
      stale: strings(e.stale),
    };
  } catch {
    return undefined;
  }
}

/** 存储错误 → 给模型的说明（存储不可用可重试）；其余原样抛出。 */
function storageError(e: unknown): unknown {
  if (e instanceof ApiError && e.code === "storage.unavailable") {
    return new ToolError(STORAGE_UNAVAILABLE_TEXT);
  }
  return e;
}

/** A stored skill file is missing or does not match its manifest entry (size, sha256). */
export class SkillIntegrityError extends Error {}

/**
 * Reads one skill file and checks it against its manifest entry (size and sha256). A missing or
 * mismatching object throws {@link SkillIntegrityError}; a storage error is rethrown as is
 * (`storage.unavailable` from the store). Shared with a person's skill invocation (phase D).
 */
export async function readSkillFile(
  store: ObjectStore,
  key: string,
  file: SkillManifest["files"][number],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const got = await store.get(key, signal && { signal });
  if (!got) throw new SkillIntegrityError(`${key} is missing`);
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = got.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > file.size) throw new SkillIntegrityError(`${key} is larger than its manifest says`);
      hash.update(value);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (n !== file.size || hash.digest("hex") !== file.sha256) {
    throw new SkillIntegrityError(`${key} does not match its manifest`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** {@link readSkillFile} for the model: integrity and storage failures become tool errors. */
async function readVerified(
  store: ObjectStore,
  key: string,
  file: SkillManifest["files"][number],
  skill: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readSkillFile(store, key, file, signal);
  } catch (e) {
    if (e instanceof SkillIntegrityError) throw new ToolError(integrityText(skill));
    throw storageError(e);
  }
}

/** 本次加载的技能版本。 */
interface LoadedVersion {
  entry: CatalogSkill;
  manifest: SkillManifest;
  prefix: string;
  store: ObjectStore;
  /** 已核对过的 SKILL.md 字节（复制时不再读一遍）。 */
  entryBytes: Uint8Array;
}

/**
 * 把技能整个复制到 `/skills/<name>/`（标记命中则跳过）。每个文件按清单核对后写入，全部写完才更新标记：
 * 中途失败下次整体重来。返回旧版本留下的文件。
 */
async function copySkill(s: SandboxSession, v: LoadedVersion): Promise<{ stale: string[] }> {
  const { name, id, version } = v.entry;
  const markerPath = skillMarkerPath(name);
  let cur: MarkerEntry | undefined;
  if (!s.reset) {
    const m = await s.p.readFile(s.h, markerPath, { maxBytes: MARKER_MAX_BYTES, signal: s.signal });
    if (m && !m.truncated) cur = parseMarker(m.data);
  }
  if (cur && cur.id === id && cur.version === version && cur.prefix === v.prefix) {
    return { stale: cur.stale };
  }
  for (const f of v.manifest.files) {
    const data =
      f.path === SKILL_ENTRY_FILE
        ? v.entryBytes
        : await readVerified(v.store, `${v.prefix}${f.path}`, f, name, s.signal);
    await s.p.writeFile(s.h, skillSandboxPath(name, f.path), data, s.signal);
  }
  const files = v.manifest.files.map((f) => f.path);
  const now = new Set(files);
  const stale = cur ? [...new Set([...cur.stale, ...cur.files])].filter((p) => !now.has(p)) : [];
  stale.sort();
  const entry: MarkerEntry = { id, version, prefix: v.prefix, files, stale };
  await s.p.writeFile(s.h, markerPath, new TextEncoder().encode(JSON.stringify(entry)), s.signal);
  return { stale };
}

/** 本步可用的工具里是否有沙箱工具（没有时模型用不了复制进去的文件）。 */
const hasSandboxTools = (ctx: BuiltinCallContext): boolean =>
  (ctx.tools ?? []).some(
    (t) =>
      t.source.kind === "builtin" &&
      (SANDBOX_TOOL_NAMES as readonly string[]).includes(t.source.name),
  );

/** 文件清单（最多 {@link MAX_LISTED_FILES} 行）。 */
function fileList(files: SkillManifest["files"]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `- ${f.path} (${f.size} bytes)`);
  if (files.length > shown.length) shown.push(`- … and ${files.length - shown.length} more files`);
  return shown.join("\n");
}

/**
 * 目录条目对应的内容，按条目的 `source`（对象前缀，T15）精确解析：先找该技能前缀相同的已生成版本（技能未删除；
 * 批准时草稿前缀原样成为版本前缀，版本号变了也能找到），再找本对话发起、仍待批准、前缀相同的技能改动（试用草稿：
 * 没有 `skill_versions` 行，新技能连 `skills` 行都没有）。绝不按版本号解析——被拒绝的草稿与之后别人批准的同号版本
 * 内容不同。都没有 → undefined（已移除）。
 */
export async function findSkillVersion(
  db: KernelDb,
  ctx: Pick<BuiltinCallContext, "orgId" | "conversationId">,
  entry: Pick<CatalogSkill, "id" | "source">,
): Promise<{ manifest: SkillManifest; object_prefix: string } | undefined> {
  const row = await db
    .selectFrom("skills")
    .innerJoin("skill_versions", "skill_versions.skill_id", "skills.id")
    .select(["skills.deleted_at", "skill_versions.manifest", "skill_versions.object_prefix"])
    .where("skills.id", "=", entry.id)
    .where("skills.org_id", "=", ctx.orgId)
    .where("skill_versions.object_prefix", "=", entry.source)
    .executeTakeFirst();
  if (row) return row.deleted_at === null ? row : undefined;
  const draft = await db
    .selectFrom("skill_change_requests")
    .select(["proposed_version", "object_prefix"])
    .where("org_id", "=", ctx.orgId)
    .where("requested_in_conversation", "=", ctx.conversationId)
    .where("status", "=", "pending")
    .where("object_prefix", "=", entry.source)
    .where(sql<string>`proposed_version ->> 'skillId'`, "=", entry.id)
    .executeTakeFirst();
  if (!draft) return undefined;
  return { manifest: draft.proposed_version.manifest, object_prefix: draft.object_prefix };
}

/** A Claude Code style qualified name `<plugin>:<skill>` (phase B, spec §9.3). */
const QUALIFIED_NAME_RE = /^([a-z0-9][a-z0-9-]{0,63}):(.+)$/;

/**
 * The catalog entry for `name`: the skill with exactly that name; else, for `<plugin>:<skill>`,
 * the skill named `<skill>` whose `plugin` (recorded in the snapshot) is `<plugin>`.
 */
function findEntry(skills: readonly CatalogSkill[], name: string): CatalogSkill | undefined {
  const exact = skills.find((s) => s.name === name);
  if (exact) return exact;
  const m = QUALIFIED_NAME_RE.exec(name);
  if (!m) return undefined;
  return skills.find((s) => s.name === m[2] && s.plugin !== undefined && s.plugin === m[1]);
}

/** The definition of the agent version this run uses; undefined without a run. */
async function runAgent(
  db: KernelDb,
  ctx: BuiltinCallContext,
): Promise<{ agentId: string; definition: AgentDefinition } | undefined> {
  if (ctx.runId === undefined) return undefined;
  const row = await db
    .selectFrom("runs")
    .innerJoin("conversations", "conversations.id", "runs.conversation_id")
    .innerJoin("agent_versions", (j) =>
      j
        .onRef("agent_versions.agent_id", "=", "conversations.agent_id")
        .onRef("agent_versions.version", "=", "runs.agent_version"),
    )
    .select(["conversations.agent_id", "agent_versions.definition"])
    .where("runs.id", "=", ctx.runId)
    .where("conversations.org_id", "=", ctx.orgId)
    .executeTakeFirst();
  return row
    ? { agentId: row.agent_id, definition: normalizeStoredDefinition(row.definition) }
    : undefined;
}

/**
 * Where an invoked skill's effectiveness is checked: the conversation, agent and agent version of
 * the person's invocation. In a sub-agent's run (a fork's child: its task message carries the
 * record the kernel wrote at dispatch) that is the PARENT: its conversation, its agent and the
 * parent run's agent version, so an org-agent child or a trial draft of the parent conversation
 * resolves as the parent did (final review I1). Undefined without a run.
 */
async function invocationScope(
  db: KernelDb,
  ctx: BuiltinCallContext,
): Promise<{ agentId: string; definition: AgentDefinition; conversationId: string } | undefined> {
  if (ctx.runId === undefined) return undefined;
  const dispatch = await dispatchOfChildRun(db, ctx.runId);
  if (!dispatch) {
    const agent = await runAgent(db, ctx);
    return agent && { ...agent, conversationId: ctx.conversationId };
  }
  const row = await db
    .selectFrom("runs")
    .innerJoin("conversations", "conversations.id", "runs.conversation_id")
    .innerJoin("agent_versions", (j) =>
      j
        .onRef("agent_versions.agent_id", "=", "conversations.agent_id")
        .onRef("agent_versions.version", "=", "runs.agent_version"),
    )
    .select(["conversations.agent_id", "agent_versions.definition"])
    .where("runs.id", "=", dispatch.parentRunId)
    .where("conversations.id", "=", dispatch.parentConversationId)
    .where("conversations.org_id", "=", ctx.orgId)
    .executeTakeFirst();
  return row
    ? {
        agentId: row.agent_id,
        definition: normalizeStoredDefinition(row.definition),
        conversationId: dispatch.parentConversationId,
      }
    : undefined;
}

/**
 * Phase D spec §4.4: a name that is not in the snapshot may be a skill a person invoked in this
 * conversation (a manual-only one never is in the catalog). Resolved from the latest
 * `user_message.skill` with that name, then checked against the effective skills of the
 * invocation's scope now ({@link invocationScope}: the parent's for a fork's sub-agent): the same
 * id and name must still be one (deleted, deselected or replaced by another skill of the same
 * name → `removed`). `conversationId` is the scope's (a trial draft is found there). Undefined
 * when nobody invoked it here (A4: the caller says "not in the catalog").
 */
async function invokedEntry(
  db: KernelDb,
  ctx: BuiltinCallContext,
  name: string,
): Promise<{ entry: CatalogSkill; conversationId: string } | "removed" | undefined> {
  // only the `skill` field: a message's content holds the rendered skill (up to 200k characters)
  const rows = await db
    .selectFrom("conversation_events")
    .select(["seq", sql<unknown>`payload -> 'skill'`.as("skill")])
    .where("conversation_id", "=", ctx.conversationId)
    .where("type", "=", "user_message")
    .where(sql<boolean>`payload -> 'skill' IS NOT NULL`)
    .orderBy("seq")
    .execute();
  const invoked = latestInvocation(
    rows.map(
      (r) => ({ type: "user_message", seq: Number(r.seq), payload: { skill: r.skill } }) as never,
    ) as ConversationEvent[],
    name,
  );
  if (!invoked) return undefined;
  const scope = await invocationScope(db, ctx);
  if (!scope) return "removed";
  const effective = await resolveSkills(db, {
    orgId: ctx.orgId,
    agentId: scope.agentId,
    agent: scope.definition,
    conversationId: scope.conversationId,
  });
  if (!effective.some((r) => r.skill.id === invoked.id && r.skill.name === invoked.name)) {
    return "removed";
  }
  return {
    entry: {
      id: invoked.id,
      name: invoked.name,
      description: "",
      version: invoked.version,
      source: invoked.source,
      ...(invoked.plugin !== undefined && { plugin: invoked.plugin }),
    },
    conversationId: scope.conversationId,
  };
}

/**
 * The line before a forked skill's instructions (spec §4.4): run it through `agent` when this step
 * offers the tool and the skill's type is in the agent's roster, else follow it yourself.
 */
async function forkLine(
  db: KernelDb,
  ctx: BuiltinCallContext,
  fork: { agent?: string },
  plugin: string | undefined,
): Promise<string> {
  const hasAgent = (ctx.tools ?? []).some(
    (t) => t.source.kind === "builtin" && t.source.name === "agent",
  );
  if (!hasAgent) return FORK_UNAVAILABLE_TEXT;
  const agent = await runAgent(db, ctx);
  if (!agent) return FORK_UNAVAILABLE_TEXT;
  const type = await resolveSkillForkType(db, ctx.orgId, agent.definition, fork.agent, plugin);
  return type.inRoster ? forkAvailableText(type.agentType) : FORK_UNAVAILABLE_TEXT;
}

/** 内置工具 `skill_load`（见文件头）。 */
export function skillLoadTool(deps: SkillLoadDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    // 可能要创建 / 恢复沙箱并复制文件：与沙箱工具同一时限
    timeoutMs: () => sandboxBaseTimeoutMs(deps.config()),
    async run(input, ctx: BuiltinCallContext) {
      const asked = (input as { name: string }).name;
      const snap = await deps.eventLog.latestOfType(ctx.conversationId, "skills_catalog");
      const skills = snap?.payload.skills ?? [];
      let entry = findEntry(skills, asked);
      // a trial draft is looked up in the conversation where the skill resolved
      let draftConversation = ctx.conversationId;
      if (!entry) {
        // phase D: a skill a person invoked here (manual-only skills are never in the catalog)
        const invoked = await invokedEntry(deps.db, ctx, asked);
        if (invoked === "removed") throw new ToolError(removedText(asked));
        if (invoked) {
          entry = invoked.entry;
          draftConversation = invoked.conversationId;
        }
      }
      if (!entry && skills.length === 0) throw new ToolError(NO_SKILLS_TEXT);
      if (!entry) throw new ToolError(notInCatalog(asked, skills));
      const name = entry.name;

      const row = await findSkillVersion(
        deps.db,
        { orgId: ctx.orgId, conversationId: draftConversation },
        entry,
      );
      if (!row) throw new ToolError(removedText(name));
      const manifest = row.manifest;
      const store = deps.storage.kernel(ctx.orgId);
      const prefix = row.object_prefix;

      const md = manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
      if (!md) throw new ToolError(integrityText(name));
      const mdBytes = await readVerified(store, `${prefix}${md.path}`, md, name, ctx.signal);
      const v: LoadedVersion = { entry, manifest, prefix, store, entryBytes: mdBytes };
      let parsed: ReturnType<typeof parseSkillMd>;
      try {
        parsed = parseSkillMd(new TextDecoder("utf-8", { fatal: true }).decode(mdBytes), {
          invocationKeys: false,
        });
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
      } else if (!hasSandboxTools(ctx)) {
        // 模型跑不了脚本：不为它创建沙箱、不复制
        filesText =
          `Skill files (for reference):\n${fileList(manifest.files)}\n` +
          "This agent has no sandbox tools, so the skill's scripts and other files cannot be run; " +
          "follow the instructions in the body without them.";
      } else {
        // the skill's marker is read, compared and written: one holder at a time per skill
        const r = await inSandbox(deps, ctx, (s) =>
          withPathLease(deps, ctx, skillMarkerPath(v.entry.name), s.signal, (signal) =>
            copySkill({ ...s, signal }, v),
          ),
        );
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
      const fork = invocationOf(manifest).fork;
      const text = [
        ...(fork ? [await forkLine(deps.db, ctx, fork, entry.plugin)] : []),
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
