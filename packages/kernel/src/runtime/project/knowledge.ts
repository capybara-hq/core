import { createHash } from "node:crypto";
import {
  isFileSystemGoneError,
  isSandboxGoneError,
  parseSkillMd,
  SKILL_ENTRY_FILE,
  SKILL_LIMITS,
} from "@capybara-hq/plugin-sdk";
import { type EventPayload, SKILLS_CATALOG_MAX } from "../../conversations/events.js";
import { POLICY_REFUSAL_PREFIX } from "../../local-devices/relay.js";
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

/** The directory of a project's skills, relative to its root. */
export const PROJECT_SKILLS_DIR = ".agents/skills";

/** How many `SKILL.md` files one run start reads at once. */
const SKILL_READ_CONCURRENCY = 8;

/** The longest `absent` reason the event takes. */
const ABSENT_MAX_CHARS = 500;

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

const reason = (s: string): string =>
  s.length <= ABSENT_MAX_CHARS ? s : `${s.slice(0, ABSENT_MAX_CHARS - 1)}…`;

/** The model-visible reasons `absent` gives (English). */
export const projectAbsence = {
  rootGone: (root: string) =>
    reason(`The project's root ${clipped(root)} no longer exists on the device.`),
  outsideMode: (root: string, mode: SandboxMode) =>
    reason(
      `The project's root ${clipped(root)} is outside what the device can read in ${mode} mode.`,
    ),
  notDirectory: (root: string) => reason(`The project's root ${clipped(root)} is not a directory.`),
  rootUnreadable: (root: string, why: string) =>
    reason(`The project's root ${clipped(root)} could not be read: ${clipped(why)}`),
  noAgentsMd: () => "The project has no AGENTS.md.",
  agentsMdUnreadable: (why: string) => reason(`AGENTS.md could not be read: ${clipped(why)}`),
} as const;

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
 * Reads the project at `target.root` through `files` (project root spec §4.4, §4.7). Every failure
 * of the project itself is a recorded reason, never a throw: a root that is gone, refused in the
 * mode, not a directory or unreadable gives `absent` and no skills; a missing or unreadable
 * `AGENTS.md` gives `absent` with the skills still read; an unparsable, missing, oversized or
 * misnamed `SKILL.md` (its `name` must be its directory's, the name `Skill` loads it by) is
 * skipped and logged. Only a lost instance or file system (for the sandbox service) and a device
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
  const absent = (why: string): ProjectRootPayload => ({ project, root, absent: why, skills: [] });
  let st: { isDir: boolean } | null;
  try {
    st = await files.stat(root);
  } catch (e) {
    if (r.fatal(e)) throw e;
    if (isPolicyRefusal(e)) return absent(projectAbsence.outsideMode(root, mode));
    return absent(projectAbsence.rootUnreadable(root, messageOf(e)));
  }
  if (st === null) return absent(projectAbsence.rootGone(root));
  if (!st.isDir) return absent(projectAbsence.notDirectory(root));

  const out: ProjectRootPayload = { project, root, skills: [] };
  try {
    const read = await files.readFile(`${root}/AGENTS.md`, AGENTS_MD_MAX_BYTES);
    if (read === null) out.absent = projectAbsence.noAgentsMd();
    else {
      const capped = capAgentsMd(decoder.decode(read.data), read.truncated);
      out.agentsMd = capped.text;
      if (capped.cut) out.agentsMdTruncated = true;
    }
  } catch (e) {
    if (r.fatal(e)) throw e;
    out.absent = projectAbsence.agentsMdUnreadable(messageOf(e));
  }
  out.skills = await readSkills(files, root, r);
  return out;
}

/** The project's skills, in directory-name order (see {@link readProjectKnowledge}). */
async function readSkills(
  files: ProjectFiles,
  root: string,
  r: Reading,
): Promise<ProjectRootPayload["skills"]> {
  if (files.list === undefined) return [];
  const dir = `${root}/${PROJECT_SKILLS_DIR}`;
  let listed: Awaited<ReturnType<NonNullable<ProjectFiles["list"]>>>;
  try {
    listed = await files.list(dir, SKILLS_CATALOG_MAX);
  } catch (e) {
    if (r.fatal(e)) throw e;
    r.log("project skills directory could not be listed; no project skills this run", {
      path: dir,
      reason: messageOf(e),
    });
    return [];
  }
  if (listed === null) return [];
  if (listed.truncated) {
    r.log(
      "project skills directory has more entries than the catalog takes; the rest are left out",
      {
        path: dir,
        limit: SKILLS_CATALOG_MAX,
      },
    );
  }
  const dirs = listed.entries.filter((e) => e.isDir).map((e) => e.name);
  const found: (ProjectRootPayload["skills"][number] | null)[] = new Array(dirs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const i = next++;
      found[i] = await readSkill(files, dir, dirs[i] as string, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SKILL_READ_CONCURRENCY, dirs.length) }, worker));
  return found.filter((s) => s !== null);
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
    read = await files.readFile(path, SKILL_LIMITS.fileBytes);
  } catch (e) {
    if (r.fatal(e)) throw e;
    return skip(`could not be read: ${messageOf(e)}`);
  }
  if (read === null) return skip(`no ${SKILL_ENTRY_FILE}`);
  if (read.truncated) return skip(`larger than ${SKILL_LIMITS.fileBytes} bytes`);
  const parsed = parseSkillMd(decoder.decode(read.data));
  if ("errors" in parsed) return skip(parsed.errors.join("; "));
  if (parsed.name !== name) {
    return skip(`its name "${parsed.name}" is not its directory's name`);
  }
  return { name, description: parsed.description, digest: digestOf(read.data) };
}

/**
 * Whether two snapshots are the same, so a run start appends nothing: the same project and root,
 * the same `AGENTS.md` text (or absence), and the same skills with the same digests.
 */
export function sameProjectRoot(a: ProjectRootPayload, b: ProjectRootPayload): boolean {
  return (
    a.project === b.project &&
    a.root === b.root &&
    a.agentsMd === b.agentsMd &&
    (a.agentsMdTruncated ?? false) === (b.agentsMdTruncated ?? false) &&
    a.absent === b.absent &&
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
