import { createHash } from "node:crypto";
import { FileSystemGoneError, SandboxGoneError, ToolError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { POLICY_REFUSAL_PREFIX } from "../../src/local-devices/relay.js";
import {
  AGENTS_MD_MAX_BYTES,
  AGENTS_MD_TRUNCATED_MARKER,
  capAgentsMd,
  type ProjectFiles,
  type ProjectRootPayload,
  readProjectKnowledge,
  sameProjectRoot,
} from "../../src/runtime/project/knowledge.js";

/**
 * Project root spec §4.4: the pure reader of a project's knowledge (the root `AGENTS.md` and the
 * `.agents/skills/*\/SKILL.md` names, descriptions and digests), over an in-memory device.
 */

const ROOT = "/home/me/src/app";
const TARGET = { project: "app", root: ROOT, mode: "auto" as const };

type Tree = Record<string, string | Uint8Array | Error>;

/** An in-memory device: `files` maps a path to its content (or the error reading it throws). */
function device(
  files: Tree,
  opts: { list?: false; listError?: Error; statError?: Error } = {},
): ProjectFiles & { reads: string[] } {
  const reads: string[] = [];
  const isDir = (p: string) => Object.keys(files).some((f) => f.startsWith(`${p}/`));
  const io: ProjectFiles & { reads: string[] } = {
    reads,
    async stat(p) {
      if (opts.statError) throw opts.statError;
      if (isDir(p)) return { size: 0, isDir: true };
      const f = files[p];
      if (f === undefined || f instanceof Error) return null;
      return { size: typeof f === "string" ? Buffer.byteLength(f) : f.byteLength, isDir: false };
    },
    async readFile(p, maxBytes) {
      reads.push(p);
      const f = files[p];
      if (f instanceof Error) throw f;
      if (f === undefined) return null;
      const data = typeof f === "string" ? Buffer.from(f, "utf8") : Buffer.from(f);
      const truncated = data.byteLength > maxBytes;
      return { data: new Uint8Array(truncated ? data.subarray(0, maxBytes) : data), truncated };
    },
  };
  if (opts.list !== false) {
    io.list = async (p, limit) => {
      if (opts.listError) throw opts.listError;
      if (!isDir(p)) return null;
      const names = new Map<string, boolean>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(`${p}/`)) continue;
        const rest = f.slice(p.length + 1);
        const slash = rest.indexOf("/");
        names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
      }
      const entries = [...names]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, dir]) => ({ name, isDir: dir }));
      return { entries: entries.slice(0, limit), truncated: entries.length > limit };
    };
  }
  return io;
}

const skill = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("readProjectKnowledge", () => {
  it("records AGENTS.md as read and the three skills with stable digests, never the bodies", async () => {
    const files: Tree = {
      [`${ROOT}/AGENTS.md`]: "# Rules\nUse pnpm.\n",
      [`${ROOT}/.agents/skills/fix-issue/SKILL.md`]: skill("fix-issue", "Fix one issue."),
      [`${ROOT}/.agents/skills/release/SKILL.md`]: skill("release", "Cut a release.", "SECRET"),
      [`${ROOT}/.agents/skills/review/SKILL.md`]: skill("review", "Review a PR."),
      [`${ROOT}/.agents/skills/review/notes.md`]: "not read",
    };
    const p = await readProjectKnowledge(device(files), TARGET);
    expect(p).toEqual({
      project: "app",
      root: ROOT,
      agentsMd: "# Rules\nUse pnpm.\n",
      skills: [
        {
          name: "fix-issue",
          description: "Fix one issue.",
          digest: sha(skill("fix-issue", "Fix one issue.")),
        },
        {
          name: "release",
          description: "Cut a release.",
          digest: sha(skill("release", "Cut a release.", "SECRET")),
        },
        {
          name: "review",
          description: "Review a PR.",
          digest: sha(skill("review", "Review a PR.")),
        },
      ],
    } satisfies ProjectRootPayload);
    expect(JSON.stringify(p)).not.toContain("SECRET");
    // the same tree reads the same: digests are stable
    expect(await readProjectKnowledge(device(files), TARGET)).toEqual(p);
    for (const s of p.skills) expect(s.digest.length).toBeLessThanOrEqual(128);
  });

  it("cuts an AGENTS.md over 64 KiB on a character boundary with the marker inside the cap", async () => {
    // a 4-byte character straddles the cut point
    const text = `${"a".repeat(AGENTS_MD_MAX_BYTES - bytes(AGENTS_MD_TRUNCATED_MARKER) - 2)}😀${"b".repeat(70_000)}`;
    const p = await readProjectKnowledge(device({ [`${ROOT}/AGENTS.md`]: text }), TARGET);
    expect(p.agentsMdTruncated).toBe(true);
    const md = p.agentsMd as string;
    expect(md.endsWith(AGENTS_MD_TRUNCATED_MARKER)).toBe(true);
    expect(bytes(md)).toBeLessThanOrEqual(AGENTS_MD_MAX_BYTES);
    const kept = md.slice(0, -AGENTS_MD_TRUNCATED_MARKER.length);
    // the emoji did not fit: cut before it, never inside it
    expect(kept).toBe("a".repeat(AGENTS_MD_MAX_BYTES - bytes(AGENTS_MD_TRUNCATED_MARKER) - 2));
    expect(md).not.toContain("�");
  });

  it("keeps an AGENTS.md of exactly 64 KiB whole and writes no truncated flag", async () => {
    const text = "x".repeat(AGENTS_MD_MAX_BYTES);
    const p = await readProjectKnowledge(device({ [`${ROOT}/AGENTS.md`]: text }), TARGET);
    expect(p.agentsMd).toBe(text);
    expect("agentsMdTruncated" in p).toBe(false);
  });

  it("skips an unparsable, a misnamed and a missing SKILL.md, each with a log line", async () => {
    const lines: string[] = [];
    const p = await readProjectKnowledge(
      device({
        [`${ROOT}/AGENTS.md`]: "rules",
        [`${ROOT}/.agents/skills/broken/SKILL.md`]: "no frontmatter at all",
        [`${ROOT}/.agents/skills/empty/README.md`]: "no SKILL.md here",
        [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine."),
        [`${ROOT}/.agents/skills/other/SKILL.md`]: skill("not-other", "Wrong directory."),
        [`${ROOT}/.agents/skills/loose.md`]: "a file, not a skill directory",
      }),
      TARGET,
      { log: (msg, detail) => lines.push(`${msg} ${String(detail.skill)}`) },
    );
    expect(p.skills.map((s) => s.name)).toEqual(["good"]);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.endsWith("broken"))).toBe(true);
    expect(lines.some((l) => l.endsWith("empty"))).toBe(true);
    expect(lines.some((l) => l.endsWith("other"))).toBe(true);
  });

  it("records a missing root as absent, without skills and without throwing", async () => {
    const p = await readProjectKnowledge(device({}), TARGET);
    expect(p).toEqual({
      project: "app",
      root: ROOT,
      absent: expect.stringContaining("no longer exists") as string,
      skills: [],
    });
    expect((p.absent as string).length).toBeLessThanOrEqual(500);
  });

  it("says a project without AGENTS.md has none and still lists its skills", async () => {
    const p = await readProjectKnowledge(
      device({ [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine.") }),
      TARGET,
    );
    expect(p.agentsMd).toBeUndefined();
    expect(p.absent).toMatch(/no AGENTS\.md/);
    expect(p.skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("records a root the device refuses in its mode, or cannot read, as absent", async () => {
    const refused = await readProjectKnowledge(
      device({}, { statError: new ToolError(`${POLICY_REFUSAL_PREFIX}outside the sandbox`) }),
      { ...TARGET, mode: "sandbox" },
    );
    expect(refused.absent).toMatch(/outside what the device can read in sandbox mode/);
    expect(refused.skills).toEqual([]);
    const unreadable = await readProjectKnowledge(
      device({}, { statError: new Error("EACCES") }),
      TARGET,
    );
    expect(unreadable.absent).toMatch(/could not be read/);
    const file = await readProjectKnowledge(device({ [ROOT]: "a file" }), TARGET);
    expect(file.absent).toMatch(/not a directory/);
  });

  it("reads AGENTS.md but no skills on a provider without list", async () => {
    const p = await readProjectKnowledge(
      device(
        {
          [`${ROOT}/AGENTS.md`]: "rules",
          [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine."),
        },
        { list: false },
      ),
      TARGET,
    );
    expect(p.agentsMd).toBe("rules");
    expect(p.skills).toEqual([]);
  });

  it("keeps AGENTS.md when the skills directory cannot be listed", async () => {
    const lines: string[] = [];
    const p = await readProjectKnowledge(
      device({ [`${ROOT}/AGENTS.md`]: "rules" }, { listError: new Error("EIO") }),
      TARGET,
      { log: (msg) => lines.push(msg) },
    );
    expect(p.agentsMd).toBe("rules");
    expect(p.skills).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("passes a lost instance or file system on (the sandbox service recovers from them)", async () => {
    await expect(
      readProjectKnowledge(device({}, { statError: new SandboxGoneError("gone") }), TARGET),
    ).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(
      readProjectKnowledge(
        device({ [`${ROOT}/x`]: "", [`${ROOT}/AGENTS.md`]: new FileSystemGoneError("fs gone") }),
        TARGET,
      ),
    ).rejects.toBeInstanceOf(FileSystemGoneError);
  });

  it("throws a device failure from any read instead of recording a half-read project", async () => {
    const down = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const isDeviceFailure = (e: unknown) => e === down;
    await expect(
      readProjectKnowledge(device({}, { statError: down }), TARGET, { isDeviceFailure }),
    ).rejects.toBe(down);
    await expect(
      readProjectKnowledge(
        device({ [`${ROOT}/AGENTS.md`]: "rules" }, { listError: down }),
        TARGET,
        { isDeviceFailure },
      ),
    ).rejects.toBe(down);
    await expect(
      readProjectKnowledge(
        device({
          [`${ROOT}/AGENTS.md`]: "rules",
          [`${ROOT}/.agents/skills/good/SKILL.md`]: down,
        }),
        TARGET,
        { isDeviceFailure },
      ),
    ).rejects.toBe(down);
    // without the predicate the same error is the root's problem
    const p = await readProjectKnowledge(device({}, { statError: down }), TARGET);
    expect(p.absent).toMatch(/could not be read/);
  });
});

describe("capAgentsMd", () => {
  it("keeps text within the cap and cuts longer text by code point", () => {
    expect(capAgentsMd("short", false)).toEqual({ text: "short", cut: false });
    // a read the provider truncated is cut even when its bytes fit
    const cut = capAgentsMd("abc", true);
    expect(cut.cut).toBe(true);
    expect(cut.text.endsWith(AGENTS_MD_TRUNCATED_MARKER)).toBe(true);
    // invalid UTF-8 decoded to U+FFFD can grow past the cap: still bounded
    const grown = capAgentsMd("�".repeat(AGENTS_MD_MAX_BYTES), false);
    expect(grown.cut).toBe(true);
    expect(bytes(grown.text)).toBeLessThanOrEqual(AGENTS_MD_MAX_BYTES);
  });
});

describe("sameProjectRoot", () => {
  const base: ProjectRootPayload = {
    project: "app",
    root: ROOT,
    agentsMd: "rules",
    skills: [{ name: "good", description: "Fine.", digest: "d1" }],
  };
  it("is true for the same snapshot and false when any digest or the text differs", () => {
    expect(sameProjectRoot(base, { ...base, agentsMdTruncated: false })).toBe(true);
    expect(sameProjectRoot(base, { ...base, agentsMd: "rules!" })).toBe(false);
    expect(
      sameProjectRoot(base, {
        ...base,
        skills: [{ name: "good", description: "Fine.", digest: "d2" }],
      }),
    ).toBe(false);
    expect(sameProjectRoot(base, { ...base, skills: [] })).toBe(false);
    const { agentsMd: _, ...rest } = base;
    expect(sameProjectRoot(base, { ...rest, absent: "gone" })).toBe(false);
  });
});
