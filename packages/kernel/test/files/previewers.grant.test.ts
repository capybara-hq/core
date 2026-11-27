import {
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewer,
  type FilePreviewProvider,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import type { EffectiveConfig } from "../../src/extensions/effective-config.js";
import { InflightTracker } from "../../src/extensions/inflight.js";
import { PreviewerRegistry } from "../../src/files/previewers.js";

/**
 * The read grant of a view previewer ends when the kernel stops waiting (tasks 11-12 review I1):
 * a render that ignores its signal and calls `read()` after the timeout, or after the extension
 * was unloaded, gets "expired" even from an object store that ignores the abort signal.
 */

const FILE = {
  id: "f1",
  name: "a.docx",
  contentType: "application/octet-stream",
  size: 5,
  objectKey: "blobs/b1",
  blob: { id: "b1", objectKey: "blobs/b1", size: 5, etag: null },
};

/** A kysely stand-in for the one `file_previewers` select `ordered()` runs. */
const db = {
  selectFrom: () => ({
    select: () => ({ where: () => ({ execute: async () => [] }) }),
  }),
} as unknown as KernelSchemaDb;

/** The bytes "hello", as a stream. */
const hello = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("hello"));
      c.close();
    },
  });

/** An object store that ignores the abort signal and always returns the bytes. */
const ignoringStore = {
  kernel: () => ({ get: async () => ({ head: { size: 5 }, body: hello() }) }),
};

/** A conversation file's blob read that ignores the abort signal as well. */
const ignoringBlobs = { open: async () => ({ head: { size: 5 }, body: hello() }) };

function setup(
  render: NonNullable<FilePreviewer["render"]>,
  timeoutMs = 50,
  effective: (orgId: string, plugin: string) => Promise<EffectiveConfig> = async () => ({
    ok: true,
    config: {},
    source: "platform",
  }),
  skillFiles: unknown = {},
) {
  const inflight = new InflightTracker("late");
  const provider: FilePreviewProvider = {
    previewers: [
      {
        id: "late",
        title: { zh: "迟", en: "Late" },
        accepts: { extensions: [".docx"] },
        maxBytes: 1024,
        render,
      },
    ],
  };
  const reg = new PreviewerRegistry(
    { db },
    {
      list: () =>
        [
          { plugin: "late", capability: FILE_PREVIEW_EXTENSION_POINT, impl: provider, inflight },
        ] as never,
      enabledPlugins: async () => new Set(["late"]),
    },
    { file: async () => FILE } as never,
    { live: async () => FILE } as never,
    ignoringBlobs as never,
    skillFiles as never,
    ignoringStore as never,
    { get: effective },
    { warn: () => {} },
    undefined as never,
    timeoutMs,
  );
  const call = (orgId = "o") =>
    reg.render({
      orgId,
      accountId: "a",
      conversationId: "c",
      fileId: "f1",
      plugin: "late",
      id: "late",
      locale: "en",
    });
  const list = (orgId = "o") => reg.forFile(orgId, "c", "a", "f1");
  const callSkill = () =>
    reg.renderSkill({
      orgId: "o",
      accountId: "a",
      skillId: "k",
      version: undefined,
      path: "doc/a.docx",
      plugin: "late",
      id: "late",
      locale: "en",
    });
  return { call, list, callSkill, inflight };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("file preview read grant", () => {
  it("expires when the render outlives the timeout", async () => {
    let late: Promise<unknown> | undefined;
    const { call } = setup(async ({ read }) => {
      await sleep(120); // ignores the signal
      late = read();
      await late.catch(() => {});
      return { blocks: [] };
    });
    await expect(call()).rejects.toMatchObject({ code: "ui.timeout" });
    await expect.poll(() => late !== undefined, { timeout: 2000 }).toBe(true);
    await expect(late).rejects.toThrow(/expired/);
  });

  it("expires when the extension is unloaded mid-call", async () => {
    let late: Promise<unknown> | undefined;
    let started!: () => void;
    const rendering = new Promise<void>((r) => {
      started = r;
    });
    const { call, inflight } = setup(async ({ read }) => {
      started();
      await sleep(80);
      late = read();
      await late.catch(() => {});
      return { blocks: [] };
    }, 5_000);
    const pending = call();
    await rendering;
    inflight.abort();
    await expect(pending).rejects.toBeTruthy();
    await expect.poll(() => late !== undefined, { timeout: 2000 }).toBe(true);
    await expect(late).rejects.toThrow(/expired/);
  });

  it("reads during the call", async () => {
    const { call } = setup(async ({ read }) => {
      const b = await read();
      return { blocks: [{ type: "text", markdown: String(b.byteLength) }] };
    }, 5_000);
    await expect(call()).resolves.toEqual({ blocks: [{ type: "text", markdown: "5" }] });
  });
});

describe("file preview and the effective config (layering spec A §6)", () => {
  /** org-a needs configuration; org-b has a copy whose `baseUrl` is "org-b". */
  const effective = async (orgId: string): Promise<EffectiveConfig> =>
    orgId === "org-a"
      ? { ok: false, issues: [{ path: "baseUrl", segments: ["baseUrl"], message: "x" }] }
      : { ok: true, config: { baseUrl: orgId === "org-b" ? "org-b" : "platform" }, source: "copy" };

  it("render gets the extension's effective config for the org", async () => {
    const seen: unknown[] = [];
    const { call } = setup(
      async (args) => {
        seen.push(args.config);
        return { blocks: [] };
      },
      5_000,
      effective,
    );
    await call("org-b");
    await call("org-c");
    expect(seen).toEqual([{ baseUrl: "org-b" }, { baseUrl: "platform" }]);
  });

  it("an extension needing configuration in the org previews nothing there", async () => {
    let calls = 0;
    const { call, list } = setup(
      async () => {
        calls++;
        return { blocks: [] };
      },
      5_000,
      effective,
    );
    expect(await list("org-a")).toEqual([]);
    await expect(call("org-a")).rejects.toMatchObject({ code: "ui.not_found" });
    expect(calls).toBe(0);
    expect((await list("org-b")).map((p) => p.id)).toEqual(["late"]);
  });
});

describe("skill file preview time limit", () => {
  const resolved = {
    store: {},
    key: "skills/x/doc/a.docx",
    path: "doc/a.docx",
    version: 1,
    size: 5,
    sha256: "0".repeat(64),
    contentType: "application/octet-stream",
  };
  /** `SkillFiles` whose verified read takes `ms` (or until its signal aborts, whichever is first). */
  const slowSkillFiles = (ms: number) => ({
    resolve: async () => resolved,
    bytes: (_f: unknown, o: { signal?: AbortSignal }) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => resolve(new TextEncoder().encode("hello")), ms);
        o.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(o.signal?.reason);
        });
      }),
  });
  const ok = async () => ({ ok: true as const, config: {}, source: "platform" as const });

  it("a read that outlives the limit is 504 ui.timeout and the previewer is not called", async () => {
    let calls = 0;
    const { callSkill } = setup(
      async () => {
        calls++;
        return { blocks: [] };
      },
      50,
      ok,
      slowSkillFiles(5_000),
    );
    await expect(callSkill()).rejects.toMatchObject({ code: "ui.timeout" });
    expect(calls).toBe(0);
  });

  it("the read and the render share one deadline", async () => {
    const { callSkill } = setup(
      async () => {
        await sleep(60); // ignores the signal; alone it would fit the 100 ms limit
        return { blocks: [] };
      },
      100,
      ok,
      slowSkillFiles(60),
    );
    await expect(callSkill()).rejects.toMatchObject({ code: "ui.timeout" });
  });

  it("reads and renders within the limit", async () => {
    const { callSkill } = setup(
      async ({ read }) => ({
        blocks: [{ type: "text", markdown: String((await read()).byteLength) }],
      }),
      5_000,
      ok,
      slowSkillFiles(1),
    );
    await expect(callSkill()).resolves.toEqual({ blocks: [{ type: "text", markdown: "5" }] });
  });
});
