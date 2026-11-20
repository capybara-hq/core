import { createHash } from "node:crypto";
import {
  isFileSystemGoneError,
  isSandboxGoneError,
  MAX_DEVICE_LIST_ENTRIES,
  parseSkillMd,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import type { EventPayload } from "../../conversations/events.js";
import { POLICY_REFUSAL_PREFIX } from "../../local-devices/relay.js";
import { PROJECT_SKILLS_DIR } from "../../sandbox/kernel-read.js";
import type { SandboxMode } from "../../sandbox/modes.js";

/**
 * The project's knowledge a bound conversation's run reads at its start (project root spec §4.4):
 * the root `AGENTS.md`, capped, and per `.agents/skills/<dir>/SKILL.md` its name, description and
 * a digest of the file. Bodies are never recorded. Pure apart from the device calls it is handed,
 * so the reader is the same for every provider and testable without one.
 */

/** The payload of a `project_root` event. */
export type ProjectRootPayload = EventPayload<"project_root">;

/** The most of a project's `AGENTS.md` a `project_root` event carries, in UTF-8 bytes (marker included). */
export const AGENTS_MD_MAX_BYTES = 64 * 1024;

/** Appended to an `AGENTS.md` cut at {@link AGENTS_MD_MAX_BYTES} (model-visible, so English). */
export const AGENTS_MD_TRUNCATED_MARKER =
  "\n\n[AGENTS.md is longer than 64 KiB; the rest was cut here]";

/** The directory of a project's skills, relative to its root (the kernel read's own constant). */
export { PROJECT_SKILLS_DIR } from "../../sandbox/kernel-read.js";

/** How many `SKILL.md` files one run start reads at once. */
const SKILL_READ_CONCURRENCY = 8;

/**
 * The most skill directories a run start reads, the first by name; a project with more says so
 * (`skillsTruncated`).
 */
export const PROJECT_SKILLS_MAX = 100;

/**
 * The most of one `SKILL.md` a run start reads, in bytes: the name and description come from its
 * frontmatter at the top, and the digest covers the bytes read.
 */
export const SKILL_MD_MAX_BYTES = 1024 * 1024;

/** The most entries one listing of the skills directory asks for (files there take no skill's place). */
const SKILLS_LIST_LIMIT = MAX_DEVICE_LIST_ENTRIES;

/** The longest `unavailable.message` the event takes. */
const MESSAGE_MAX_CHARS = 500;

/** The device calls the reader makes, already bound to the instance, the mode and a signal. */
export interface ProjectFiles {
  stat(path: string): Promise<{ size: number; isDir: boolean } | null>;
  readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  /** One directory's entries; absent when the provider cannot list (then: no skills). */
  list?(
    path: string,
    limit: number,
  ): Promise<{ entries: { name: string; isDir: boolean }[]; truncated: boolean } | null>;
}

/** What is read: the bound project and the device's effective mode (for the reasons). */
export interface ProjectTarget {
  project: string;
  root: string;
  mode: SandboxMode;
}

/** A log line about a skipped skill or an unreadable skills directory. */
export type ProjectKnowledgeLog = (msg: string, detail: Record<string, unknown>) => void;

/** Options of {@link readProjectKnowledge}. */
export interface ReadProjectKnowledgeOptions {
  log?: ProjectKnowledgeLog;
  /**
   * Whether an error means the device could not be asked (the provider unreachable, the device
   * offline, an abort), not that the project is unreadable: such an error is thrown, so no
   * snapshot is recorded from a half-read project. A lost instance or file system always is.
   */
  isDeviceFailure?: (e: unknown) => boolean;
}

/** The idempotency key of a run's `project_root` event (a retried run start appends it once). */
export const projectRootIdemKey = (runId: string): string => `project_root:${runId}`;

/** A device path or a device error inside a reason, bounded. */
function clipped(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Why a run cannot use its project: a `project_root` event's `unavailable`. */
export type ProjectUnavailable = NonNullable<ProjectRootPayload["unavailable"]>;

const unavailable = (reason: ProjectUnavailable["reason"], text: string): ProjectUnavailable => ({
  reason,
  message: text.length <= MESSAGE_MAX_CHARS ? text : `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…`,
});

/** The `unavailable` values a reader records: a reason code and an English message for the model. */
export const projectUnavailable = {
  gone: (root: string) =>
    unavailable("gone", `The project's root ${clipped(root)} no longer exists on the device.`),
  outsideMode: (root: string, mode: SandboxMode) =>
    unavailable(
      "outside_mode",
      `The project's root ${clipped(root)} is outside what the device can read in ${mode} mode.`,
    ),
  notDirectory: (root: string) =>
    unavailable("unreadable", `The project's root ${clipped(root)} is not a directory.`),
  /** The device's own error text is logged, never recorded: the message stays the same per root. */
  unreadable: (root: string) =>
    unavailable("unreadable", `The project's root ${clipped(root)} could not be read.`),
  removed: (project: string) =>
    unavailable(
      "removed",
      `The project "${clipped(project, 80)}" was removed from the device's projects.`,
    ),
  /** A host machine whose runtime cannot enforce the kernel's read-only read (gate on). */
  notEnforceable: (root: string) =>
    unavailable(
      "unreadable",
      `The project's root ${clipped(root)} was not read: this device's runtime cannot enforce a read-only read on its host; turn on its sandbox enforcement or use another device.`,
    ),
  /** A device runtime that refused the kernel's read-only read scope (its text is logged). */
  refused: (root: string) =>
    unavailable(
      "unreadable",
      `The project's root ${clipped(root)} was not read: this device's runtime refused the kernel's read-only read.`,
    ),
  unsupported: () =>
    unavailable(
      "unsupported",
      "The device does not offer projects; capybara-device on that machine needs an update.",
    ),
} as const;

/** The snapshot of a project the run cannot use: the reason alone, no AGENTS.md, no skills. */
export const unavailableProject = (
  project: string,
  root: string,
  why: ProjectUnavailable,
): ProjectRootPayload => ({ project, root, unavailable: why, skills: [] });

/** A lost instance or file system: passed on, so the sandbox service recovers or records it. */
const isGone = (e: unknown): boolean => isSandboxGoneError(e) || isFileSystemGoneError(e);

/** The reader's own context: whether an error is thrown, and where skipped skills are logged. */
interface Reading {
  log: ProjectKnowledgeLog;
  /** A lost instance or file system, or a device failure: thrown, never recorded. */
  fatal: (e: unknown) => boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isPolicyRefusal = (e: unknown): boolean =>
  e instanceof Error && e.message.startsWith(POLICY_REFUSAL_PREFIX);

/** The hex sha256 of a file's bytes: a skill's digest. */
const digestOf = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * `text` within {@link AGENTS_MD_MAX_BYTES} UTF-8 bytes: unchanged when it fits and the read was
 * whole; otherwise cut on a code point boundary and followed by {@link AGENTS_MD_TRUNCATED_MARKER},
 * marker included in the cap. Measured on the decoded string, so invalid bytes the decoder turned
 * into U+FFFD cannot push it past the cap.
 */
export function capAgentsMd(text: string, readTruncated: boolean): { text: string; cut: boolean } {
  if (!readTruncated && Buffer.byteLength(text, "utf8") <= AGENTS_MD_MAX_BYTES) {
    return { text, cut: false };
  }
  const budget = AGENTS_MD_MAX_BYTES - Buffer.byteLength(AGENTS_MD_TRUNCATED_MARKER, "utf8");
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > budget) break;
    used += n;
    end += ch.length;
  }
  return { text: `${text.slice(0, end)}${AGENTS_MD_TRUNCATED_MARKER}`, cut: true };
}

const decoder = new TextDecoder("utf-8");

/**
 * A SKILL.md is decoded strictly, as `readProjectSkill` decodes it when `Skill` loads it: a file
 * that is not UTF-8 is skipped here, so the catalog never lists a skill that cannot be loaded.
 */
const skillDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads the project at `target.root` through `files` (project root spec §4.4, §4.7). Every failure
 * of the project itself is recorded, never thrown: a root that is gone, refused in the mode, not a
 * directory or unreadable gives `unavailable` with its reason code and nothing else; a missing
 * `AGENTS.md` is simply left out (spec §4.7: a project with skills only), an unreadable one too,
 * with a log line; the first {@link PROJECT_SKILLS_MAX} skill directories by name are read
 * (`skillsTruncated` when there are more), each `SKILL.md` up to {@link SKILL_MD_MAX_BYTES}; an
 * unparsable, missing or misnamed `SKILL.md` (its `name` must be its directory's, the name `Skill`
 * loads it by) is skipped and logged. Only a lost instance or file system (for the sandbox service) and a device
 * failure ({@link ReadProjectKnowledgeOptions.isDeviceFailure}) are thrown.
 */
export async function readProjectKnowledge(
  files: ProjectFiles,
  target: ProjectTarget,
  opts: ReadProjectKnowledgeOptions = {},
): Promise<ProjectRootPayload> {
  const { project, root, mode } = target;
  const deviceFailure = opts.isDeviceFailure ?? (() => false);
  const r: Reading = {
    log: opts.log ?? (() => {}),
    fatal: (e) => isGone(e) || deviceFailure(e),
  };
  const cannot = (why: ProjectUnavailable) => unavailableProject(project, root, why);
  let st: { isDir: boolean } | null;
  try {
    st = await files.stat(root);
  } catch (e) {
    if (r.fatal(e)) throw e;
    if (isPolicyRefusal(e)) return cannot(projectUnavailable.outsideMode(root, mode));
    r.log("project root could not be read", { path: root, reason: messageOf(e) });
    return cannot(projectUnavailable.unreadable(root));
  }
  if (st === null) return cannot(projectUnavailable.gone(root));
  if (!st.isDir) return cannot(projectUnavailable.notDirectory(root));

  const out: ProjectRootPayload = { project, root, skills: [] };
  const agentsMd = `${root}/AGENTS.md`;
  try {
    const read = await files.readFile(agentsMd, AGENTS_MD_MAX_BYTES);
    // none: a project with skills only, nothing to say (spec §4.7)
    if (read !== null) {
      const capped = capAgentsMd(decoder.decode(read.data), read.truncated);
      out.agentsMd = capped.text;
      if (capped.cut) out.agentsMdTruncated = true;
    }
  } catch (e) {
    if (r.fatal(e)) throw e;
    r.log("project AGENTS.md could not be read; left out this run", {
      path: agentsMd,
      reason: messageOf(e),
    });
  }
  const skills = await readSkills(files, root, r);
  out.skills = skills.skills;
  if (skills.truncated) out.skillsTruncated = true;
  return out;
}

/**
 * The project's skills, the first {@link PROJECT_SKILLS_MAX} directories in name order (see
 * {@link readProjectKnowledge}); `truncated` when the directory holds more (or more entries than
 * one listing returns, so more may exist).
 */
async function readSkills(
  files: ProjectFiles,
  root: string,
  r: Reading,
): Promise<{ skills: ProjectRootPayload["skills"]; truncated: boolean }> {
  const none = { skills: [], truncated: false };
  if (files.list === undefined) return none;
  const dir = `${root}/${PROJECT_SKILLS_DIR}`;
  let listed: Awaited<ReturnType<NonNullable<ProjectFiles["list"]>>>;
  try {
    listed = await files.list(dir, SKILLS_LIST_LIMIT);
  } catch (e) {
    if (r.fatal(e)) throw e;
    r.log("project skills directory could not be listed; no project skills this run", {
      path: dir,
      reason: messageOf(e),
    });
    return none;
  }
  if (listed === null) return none;
  // the listing is sorted by code unit; sorted again so the cut never depends on the provider
  const all = listed.entries
    .filter((e) => e.isDir)
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const truncated = listed.truncated || all.length > PROJECT_SKILLS_MAX;
  if (truncated) {
    r.log("project has more skill directories than a run reads; the rest are left out", {
      path: dir,
      limit: PROJECT_SKILLS_MAX,
    });
  }
  const dirs = all.slice(0, PROJECT_SKILLS_MAX);
  const found: (ProjectRootPayload["skills"][number] | null)[] = new Array(dirs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const i = next++;
      found[i] = await readSkill(files, dir, dirs[i] as string, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SKILL_READ_CONCURRENCY, dirs.length) }, worker));
  return { skills: found.filter((s) => s !== null), truncated };
}

/** One skill's catalog entry, or null (skipped and logged). */
async function readSkill(
  files: ProjectFiles,
  dir: string,
  name: string,
  r: Reading,
): Promise<ProjectRootPayload["skills"][number] | null> {
  const path = `${dir}/${name}/${SKILL_ENTRY_FILE}`;
  const skip = (why: string) => {
    r.log("project skill skipped", { skill: name, path, reason: why });
    return null;
  };
  let read: { data: Uint8Array; truncated: boolean } | null;
  try {
    read = await files.readFile(path, SKILL_MD_MAX_BYTES);
  } catch (e) {
    if (r.fatal(e)) throw e;
    return skip(`could not be read: ${messageOf(e)}`);
  }
  if (read === null) return skip(`no ${SKILL_ENTRY_FILE}`);
  // a longer file is parsed and digested as far as it was read: its frontmatter is at the top
  let text: string;
  try {
    text = skillDecoder.decode(read.data);
  } catch {
    return skip("it is not UTF-8 text");
  }
  const parsed = parseSkillMd(text);
  if ("errors" in parsed) return skip(parsed.errors.join("; "));
  if (parsed.name !== name) {
    return skip(`its name "${parsed.name}" is not its directory's name`);
  }
  return { name, description: parsed.description, digest: digestOf(read.data) };
}

/**
 * Whether two snapshots are the same, so a run start appends nothing: the same project and root,
 * the same `AGENTS.md` text (or none), the same unavailability, and the same skills with the same
 * digests (and the same cut).
 */
export function sameProjectRoot(a: ProjectRootPayload, b: ProjectRootPayload): boolean {
  return (
    a.project === b.project &&
    a.root === b.root &&
    a.agentsMd === b.agentsMd &&
    (a.agentsMdTruncated ?? false) === (b.agentsMdTruncated ?? false) &&
    a.unavailable?.reason === b.unavailable?.reason &&
    a.unavailable?.message === b.unavailable?.message &&
    (a.skillsTruncated ?? false) === (b.skillsTruncated ?? false) &&
    a.skills.length === b.skills.length &&
    a.skills.every((s, i) => {
      const t = b.skills[i];
      return (
        t !== undefined &&
        s.name === t.name &&
        s.description === t.description &&
        s.digest === t.digest
      );
    })
  );
}
