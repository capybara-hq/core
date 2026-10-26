import type { ConversationEvent, EventPayload } from "../../conversations/events.js";

/**
 * 技能目录在模型请求里的渲染（M5 T14，Ruling M17）。纯函数：只取决于日志里的 `skills_catalog` 快照，
 * 请求可由日志还原。模型可见文案一律英文。
 */

/** 快照里的一项技能。 */
export type CatalogSkill = EventPayload<"skills_catalog">["skills"][number];

/** The whole `skills_catalog` payload. */
export type SkillsSnapshot = EventPayload<"skills_catalog">;

/** A pinned skill in a snapshot (phase B, spec §9.1). */
export type PinnedSkill = NonNullable<SkillsSnapshot["pinned"]>[number];

/** 日志里的 `skills_catalog` 事件。 */
export type SkillsCatalogEvent = Extract<ConversationEvent, { type: "skills_catalog" }>;

/** 加载技能的内置工具名。 */
export const SKILL_LOAD = "skill_load";

/** 目录开头的说明（system 缓存段里的第一份目录）。 */
export const SKILLS_CATALOG_HEADER =
  "Skills are available in this conversation. A skill is a set of instructions, sometimes with " +
  "scripts or other files, for a specific kind of task. When a task matches a skill's description, " +
  `call ${SKILL_LOAD} with the skill's name to read its instructions before you start; do not guess ` +
  "what a skill says. Available skills:";

/** 按码点比较名字（与区域设置无关，结果确定）。 */
const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** 目录里每个技能描述最多的码点数（超出确定地截断；`skill_load` 仍返回完整正文）。 */
export const CATALOG_DESCRIPTION_MAX_CHARS = 300;

/** 折叠成一行，按码点截到 {@link CATALOG_DESCRIPTION_MAX_CHARS}。 */
function shortDescription(d: string): string {
  const flat = d.replace(/\s+/g, " ").trim();
  const cps = [...flat];
  return cps.length <= CATALOG_DESCRIPTION_MAX_CHARS
    ? flat
    : `${cps.slice(0, CATALOG_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

/** 一行：`- <name>: <description>`（描述折叠成一行并截断）。 */
const line = (s: CatalogSkill) => `- ${s.name}: ${shortDescription(s.description)}`;

const lines = (skills: readonly CatalogSkill[]) => [...skills].sort(byName).map(line).join("\n");

/** 第一份目录（进 system 缓存段），按名字排序。 */
export function skillsCatalogText(skills: readonly CatalogSkill[]): string {
  return `${SKILLS_CATALOG_HEADER}\n${lines(skills)}`;
}

/** 两份快照是否相同（按 id、版本、名字、描述与来源）。顺序无关。 */
export function sameSkills(a: readonly CatalogSkill[], b: readonly CatalogSkill[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((s) => [s.id, s]));
  if (byId.size !== a.length) return false;
  return b.every((s) => {
    const p = byId.get(s.id);
    return (
      p !== undefined &&
      p.version === s.version &&
      p.name === s.name &&
      p.description === s.description &&
      p.source === s.source
    );
  });
}

/** Two pinned lists are the same: id, version and source in order (absent = []). Bodies follow the source. */
export function samePinned(
  a: readonly PinnedSkill[] | undefined,
  b: readonly PinnedSkill[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return (
    x.length === y.length &&
    x.every((p, i) => {
      const q = y[i];
      return q !== undefined && p.id === q.id && p.version === q.version && p.source === q.source;
    })
  );
}

/**
 * Two snapshots are the same: {@link sameSkills} (`plugin` is not compared, so a snapshot written
 * before phase B stays current), {@link samePinned} and the same `toolMap` (absent = undefined).
 */
export function sameSnapshot(a: SkillsSnapshot, b: SkillsSnapshot): boolean {
  return (
    sameSkills(a.skills, b.skills) && samePinned(a.pinned, b.pinned) && a.toolMap === b.toolMap
  );
}

/**
 * 目录变更提醒（之后的快照在所在位置以 system 消息追加）：新增、移除、更新（同一 id 的版本、描述或来源变了：
 * 试用草稿被拒绝 / 批准了别人的同号版本时，内容变了而版本号可能不变）。
 * `prev` 为上一份快照（没有为空）。
 */
export function skillsChangeText(
  prev: readonly CatalogSkill[],
  next: readonly CatalogSkill[],
): string {
  const before = new Map(prev.map((s) => [s.id, s]));
  const after = new Map(next.map((s) => [s.id, s]));
  const added = next.filter((s) => !before.has(s.id));
  const removed = prev.filter((s) => !after.has(s.id));
  const updated = next.filter((s) => {
    const p = before.get(s.id);
    return (
      p !== undefined &&
      (p.version !== s.version || p.description !== s.description || p.source !== s.source)
    );
  });
  const parts = ["The skills available in this conversation have changed."];
  if (added.length > 0) {
    parts.push(`New skills (call ${SKILL_LOAD} with the name to use one):\n${lines(added)}`);
  }
  if (updated.length > 0) {
    parts.push(
      `Updated skills (call ${SKILL_LOAD} again before relying on earlier instructions):\n${lines(updated)}`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `Removed skills (no longer available; do not use them): ${[...removed]
        .sort(byName)
        .map((s) => s.name)
        .join(", ")}`,
    );
  }
  if (next.length === 0) parts.push("No skills are available now.");
  return parts.join("\n\n");
}

/** 压缩摘要之后补上的「当前目录」（与 system 里的第一份不同时）：完整列出，替代之前的目录与提醒。 */
export function skillsCurrentText(skills: readonly CatalogSkill[]): string {
  if (skills.length === 0) {
    return "No skills are available in this conversation now (this replaces any earlier list of skills).";
  }
  return (
    "Skills available in this conversation now (this replaces any earlier list of skills; call " +
    `${SKILL_LOAD} with a name to read a skill's instructions):\n${lines(skills)}`
  );
}

/** 日志里的全部 `skills_catalog` 事件，按 seq 升序。 */
export function skillsCatalogEvents(events: readonly ConversationEvent[]): SkillsCatalogEvent[] {
  return events
    .filter((e): e is SkillsCatalogEvent => e.type === "skills_catalog")
    .sort((a, b) => a.seq - b.seq);
}

/** 最新一份快照；没有为 null。 */
export function latestSkillsCatalog(
  events: readonly ConversationEvent[],
): SkillsCatalogEvent | null {
  return skillsCatalogEvents(events).at(-1) ?? null;
}

/**
 * 进 system 缓存段的快照：第一份快照，且它之前没有任何 `model_call`（对话已经发过请求之后才有技能时，
 * 改为在所在位置追加提醒，已发送的前缀不变）。没有为 null。
 */
export function systemSkillsCatalog(
  events: readonly ConversationEvent[],
): SkillsCatalogEvent | null {
  const first = skillsCatalogEvents(events)[0];
  if (!first) return null;
  const earlierCall = events.some((e) => e.type === "model_call" && e.seq < first.seq);
  return earlierCall ? null : first;
}
