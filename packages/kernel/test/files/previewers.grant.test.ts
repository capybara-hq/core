import {
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewer,
  type FilePreviewProvider,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
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

function setup(render: NonNullable<FilePreviewer["render"]>, timeoutMs = 50) {
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
  const reg = new PreviewerRegistry({
    db,
    host: {
      list: () =>
        [
          { plugin: "late", capability: FILE_PREVIEW_EXTENSION_POINT, impl: provider, inflight },
        ] as never,
    },
    enabledPlugins: async () => new Set(["late"]),
    files: { file: async () => FILE } as never,
    storage: ignoringStore as never,
    log: { warn: () => {} },
    timeoutMs,
  });
  const call = () =>
    reg.render({
      orgId: "o",
      accountId: "a",
      conversationId: "c",
      fileId: "f1",
      plugin: "late",
      id: "late",
      locale: "en",
    });
  return { call, inflight };
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
    const { call, inflight } = setup(async ({ read }) => {
      await sleep(80);
      late = read();
      await late.catch(() => {});
      return { blocks: [] };
    }, 5_000);
    const pending = call();
    await sleep(10);
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
