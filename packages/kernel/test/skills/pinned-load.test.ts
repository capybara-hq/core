import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SkillManifest } from "../../src/db/kernel-schema.js";
import { ApiError } from "../../src/errors.js";
import {
  fitPinned,
  loadPinnedBodies,
  PINNED_SKILLS_LIMITS,
  pinnedFailureText,
} from "../../src/skills/catalog.js";
import type { StorageService } from "../../src/storage/storage.service.js";

/**
 * Reading pinned SKILL.md bodies at run start (phase B, Decision 9) and fitting them into the
 * size limit, with a stub object store.
 */

const enc = new TextEncoder();
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;

function candidate(name: string, text: string) {
  const bytes = enc.encode(text);
  const manifest: SkillManifest = {
    name,
    description: `Use for ${name} work.`,
    files: [
      {
        path: "SKILL.md",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  return { id: `id-${name}`, version: 1, name, source: `skills/${name}/`, manifest };
}

/** A storage stub whose `get` answers from `answers` in turn (an Error is thrown). */
function stubStorage(answers: (string | null | Error)[]) {
  const get = vi.fn(async () => {
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (a === null || a === undefined) return null;
    return { body: new Blob([a]).stream() };
  });
  const storage = {
    assertAvailable: () => {},
    kernel: () => ({ get }),
  } as unknown as StorageService;
  return { storage, get };
}

const fakeLog = () => ({ warn: vi.fn(), error: vi.fn() });

describe("loadPinnedBodies", () => {
  it("a read that fails once is retried and the run proceeds (M6)", async () => {
    const text = skillMd("alpha", "Alpha body.");
    const { storage, get } = stubStorage([new Error("ECONNRESET"), text]);
    const log = fakeLog();
    const out = await loadPinnedBodies(storage, "org", [candidate("alpha", text)], { log });
    expect(out.map((p) => p.body)).toEqual(["Alpha body."]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("two failed reads: storage.unavailable, transient (no owner action)", async () => {
    const text = skillMd("alpha", "Alpha body.");
    const { storage } = stubStorage([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const log = fakeLog();
    const err = await loadPinnedBodies(storage, "org", [candidate("alpha", text)], { log }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("storage.unavailable");
    expect(pinnedFailureText(err as ApiError)).toBe(
      "File storage is temporarily unavailable, so this agent's pinned skills cannot be read; send the message again later.",
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    ["an integrity mismatch", skillMd("alpha", "tampered")],
    ["a missing object", null],
  ])(
    "%s: logged at error with the skill id and source, and an owner-facing message (M4)",
    async (_l, stored) => {
      const text = skillMd("alpha", "Alpha body.");
      const { storage, get } = stubStorage([stored]);
      const log = fakeLog();
      const err = await loadPinnedBodies(storage, "org", [candidate("alpha", text)], { log }).catch(
        (e: unknown) => e,
      );
      expect((err as ApiError).code).toBe("storage.unavailable");
      // a permanent failure is not retried
      expect(get).toHaveBeenCalledTimes(1);
      expect(pinnedFailureText(err as ApiError)).toBe(
        `Pinned skill "alpha" cannot be read; ask the agent's owner to unpin it or upload it again.`,
      );
      expect(log.error).toHaveBeenCalledWith(
        "pinned skill unreadable",
        expect.objectContaining({ orgId: "org", skillId: "id-alpha", source: "skills/alpha/" }),
      );
    },
  );
});

describe("fitPinned", () => {
  const pinned = (name: string, bytes: number) => ({
    id: `id-${name}`,
    version: 1,
    name,
    source: `skills/${name}/`,
    body: "x".repeat(bytes),
  });

  it("keeps the leading skills that fit and warns with kept and dropped (M5)", () => {
    const log = fakeLog();
    const input = [pinned("alpha", 3_000), pinned("beta", 30_000), pinned("gamma", 10)];
    const out = fitPinned(input, log, { orgId: "o", agentId: "a", conversationId: "c" });
    expect(out.map((p) => p.name)).toEqual(["alpha"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("pinned skills over the limit", {
      orgId: "o",
      agentId: "a",
      conversationId: "c",
      kept: ["alpha"],
      dropped: ["beta", "gamma"],
      maxBytes: PINNED_SKILLS_LIMITS.totalBytes,
    });
  });

  it("everything fits: no warning", () => {
    const log = fakeLog();
    const input = [pinned("alpha", 3_000), pinned("beta", 3_000)];
    expect(fitPinned(input, log, {})).toEqual(input);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
