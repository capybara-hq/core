import { createHash } from "node:crypto";
import { FileSystemGoneError, SandboxGoneError, ToolError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { POLICY_REFUSAL_PREFIX } from "../../src/local-devices/relay.js";
import {
  AGENTS_MD_MAX_BYTES,
  AGENTS_MD_TRUNCATED_MARKER,
  capAgentsMd,
  PROJECT_SKILLS_MAX,
  type ProjectFiles,
  type ProjectRootPayload,
  readProjectKnowledge,
  SKILL_MD_MAX_BYTES,
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

  it("skips a SKILL.md that is not UTF-8 with a log line, as Skill would refuse to load it", async () => {
    const lines: string[] = [];
    const bad = Buffer.concat([Buffer.from(skill("latin", "Caf")), Buffer.from([0xe9, 0x0a])]);
    const p = await readProjectKnowledge(
      device({
        [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine."),
        [`${ROOT}/.agents/skills/latin/SKILL.md`]: new Uint8Array(bad),
      }),
      TARGET,
      {
        log: (msg, detail) => lines.push(`${msg} ${String(detail.skill)} ${String(detail.reason)}`),
      },
    );
    expect(p.skills.map((s) => s.name)).toEqual(["good"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/latin .*UTF-8/);
  });

  it("records a missing root as unavailable (gone), without skills and without throwing", async () => {
    const p = await readProjectKnowledge(device({}), TARGET);
    expect(p).toEqual({
      project: "app",
      root: ROOT,
      unavailable: {
        reason: "gone",
        message: expect.stringContaining("no longer exists") as string,
      },
      skills: [],
    });
    expect(p.unavailable?.message.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("omits AGENTS.md of a project without one, with no reason, and still lists its skills", async () => {
    const p = await readProjectKnowledge(
      device({ [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine.") }),
      TARGET,
    );
    expect(p).toEqual({
      project: "app",
      root: ROOT,
      skills: [expect.objectContaining({ name: "good" })],
    });
  });

  it("omits an AGENTS.md that cannot be read, with a log line, and keeps the skills", async () => {
    const lines: string[] = [];
    const p = await readProjectKnowledge(
      device({
        [`${ROOT}/AGENTS.md`]: new Error("EACCES"),
        [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine."),
      }),
      TARGET,
      { log: (msg) => lines.push(msg) },
    );
    expect(p.agentsMd).toBeUndefined();
    expect(p.unavailable).toBeUndefined();
    expect(p.skills.map((s) => s.name)).toEqual(["good"]);
    expect(lines).toHaveLength(1);
  });

  it("records a root refused in the mode, unreadable or a file with its reason code", async () => {
    const refused = await readProjectKnowledge(
      device({}, { statError: new ToolError(`${POLICY_REFUSAL_PREFIX}outside the sandbox`) }),
      { ...TARGET, mode: "sandbox" },
    );
    expect(refused.unavailable?.reason).toBe("outside_mode");
    expect(refused.unavailable?.message).toMatch(
      /outside what the device can read in sandbox mode/,
    );
    expect(refused.skills).toEqual([]);
    const unreadable = await readProjectKnowledge(
      device({}, { statError: new Error("EACCES") }),
      TARGET,
    );
    expect(unreadable.unavailable).toEqual({
      reason: "unreadable",
      message: expect.stringMatching(/could not be read/) as string,
    });
    // the raw error goes to the log, never into the recorded message: the same root records the
    // same message whatever the error said
    const logged: unknown[] = [];
    const other = await readProjectKnowledge(
      device({}, { statError: new Error("EIO: i/o error, scandir 0x7f3a") }),
      TARGET,
      { log: (_msg, detail) => logged.push(detail.reason) },
    );
    expect(unreadable.unavailable?.message).not.toContain("EACCES");
    expect(other.unavailable).toEqual(unreadable.unavailable);
    expect(logged).toEqual(["EIO: i/o error, scandir 0x7f3a"]);
    const file = await readProjectKnowledge(device({ [ROOT]: "a file" }), TARGET);
    expect(file.unavailable).toEqual({
      reason: "unreadable",
      message: expect.stringMatching(/not a directory/) as string,
    });
  });

  it("keeps the first 100 skill directories by name and says when there were more", async () => {
    const tree: Tree = { [`${ROOT}/AGENTS.md`]: "rules" };
    const name = (i: number) => `s-${String(i).padStart(3, "0")}`;
    for (let i = 0; i < PROJECT_SKILLS_MAX + 5; i++) {
      tree[`${ROOT}/.agents/skills/${name(i)}/SKILL.md`] = skill(name(i), "One.");
    }
    // files in the directory do not take a skill's place
    tree[`${ROOT}/.agents/skills/a-readme.md`] = "a file";
    const files = device(tree);
    const p = await readProjectKnowledge(files, TARGET);
    expect(p.skills).toHaveLength(PROJECT_SKILLS_MAX);
    expect(p.skills[0]?.name).toBe(name(0));
    expect(p.skills.at(-1)?.name).toBe(name(PROJECT_SKILLS_MAX - 1));
    expect(p.skillsTruncated).toBe(true);
    expect(files.reads.filter((r) => r.endsWith("SKILL.md"))).toHaveLength(PROJECT_SKILLS_MAX);
    const few = await readProjectKnowledge(
      device({ [`${ROOT}/.agents/skills/good/SKILL.md`]: skill("good", "Fine.") }),
      TARGET,
    );
    expect("skillsTruncated" in few).toBe(false);
  });

  it("reads a SKILL.md up to 1 MiB and digests the bytes read", async () => {
    const head = skill("big", "Large.");
    const big = `${head}${"x".repeat(SKILL_MD_MAX_BYTES + 10)}`;
    const p = await readProjectKnowledge(
      device({ [`${ROOT}/.agents/skills/big/SKILL.md`]: big }),
      TARGET,
    );
    expect(p.skills).toEqual([
      { name: "big", description: "Large.", digest: sha(big.slice(0, SKILL_MD_MAX_BYTES)) },
    ]);
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
    expect(p.unavailable?.reason).toBe("unreadable");
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
    expect(sameProjectRoot(base, { ...base })).toBe(true);
    expect(sameProjectRoot(base, { ...base, skillsTruncated: true })).toBe(false);
    expect(sameProjectRoot(base, { ...base, agentsMd: "rules!" })).toBe(false);
    expect(
      sameProjectRoot(base, {
        ...base,
        skills: [{ name: "good", description: "Fine.", digest: "d2" }],
      }),
    ).toBe(false);
    expect(sameProjectRoot(base, { ...base, skills: [] })).toBe(false);
    const { agentsMd: _, ...rest } = base;
    expect(
      sameProjectRoot(
        { ...rest, skills: [], unavailable: { reason: "gone", message: "Gone." } },
        { ...rest, skills: [], unavailable: { reason: "unreadable", message: "Gone." } },
      ),
    ).toBe(false);
  });
});
