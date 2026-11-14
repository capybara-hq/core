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
  objectKey: "artifacts/c/f1",
};

/** A kysely stand-in for the one `file_previewers` select `ordered()` runs. */
const db = {
  selectFrom: () => ({
    select: () => ({ where: () => ({ execute: async () => [] }) }),
  }),
} as unknown as KernelSchemaDb;

/** An object store that ignores the abort signal and always returns the bytes. */
const ignoringStore = {
  kernel: () => ({
    get: async () => ({
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      }),
    }),
  }),
};

function setup(
  render: NonNullable<FilePreviewer["render"]>,
  timeoutMs = 50,
  effective: (orgId: string, plugin: string) => Promise<EffectiveConfig> = async () => ({
    ok: true,
    config: {},
    source: "platform",
  }),
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
  return { call, list, inflight };
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
