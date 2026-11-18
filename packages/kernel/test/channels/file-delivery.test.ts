import type { ObjectStore } from "@capybara-hq/plugin-sdk";
import { asCode, ExtensionPointUnavailableError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  FileSlots,
  fileLinkText,
  fileRootText,
  formatFileSize,
  planFileDelivery,
  pluginFileName,
  readArtifactCapped,
} from "../../src/channels/file-delivery.js";
import { ConfigError, resolveConfig } from "../../src/config/load.js";
import { storageUnavailable } from "../../src/storage/storage.service.js";
import { MemoryObjectStore } from "../storage/memory-store.js";

const files = { maxBytes: 100_000, imageMaxBytes: 10_000 };
const features = { cards: true, edit: true, threads: true, files };
const plan = (
  artifact: { objectKey?: string; size: number; contentType: string },
  over: Partial<Parameters<typeof planFileDelivery>[0]> = {},
) =>
  planFileDelivery({
    conversationId: "c1",
    artifact: { objectKey: "artifacts/c1/a1", ...artifact },
    features,
    canSendFile: true,
    fileMaxBytes: 20_971_520,
    ...over,
  });

describe("planFileDelivery", () => {
  it("native image within imageMaxBytes, file above it", () => {
    expect(plan({ size: 1024, contentType: "image/png" })).toEqual({
      mode: "native",
      kind: "image",
      cap: 100_000,
    });
    expect(plan({ size: 20_000, contentType: "image/png" })).toMatchObject({
      mode: "native",
      kind: "file",
    });
  });
  it("content type params and case are ignored; svg and heic are files", () => {
    expect(plan({ size: 100, contentType: "IMAGE/PNG; charset=binary" })).toMatchObject({
      kind: "image",
    });
    expect(plan({ size: 100, contentType: "image/svg+xml" })).toMatchObject({ kind: "file" });
    expect(plan({ size: 100, contentType: "image/heic" })).toMatchObject({ kind: "file" });
  });
  it("an invalid features.files declaration is no native support; a bad imageMaxBytes falls back", () => {
    const t = { size: 100, contentType: "image/png" };
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, undefined]) {
      const f = { ...features, files: { maxBytes } } as unknown as typeof features;
      expect(plan(t, { features: f })).toEqual({ mode: "link", reason: "unsupported" });
    }
    for (const imageMaxBytes of [Number.NaN, 0, -1]) {
      const f = { ...features, files: { maxBytes: 50, imageMaxBytes } };
      expect(plan({ ...t, size: 40 }, { features: f })).toMatchObject({ kind: "image", cap: 50 });
      expect(plan(t, { features: f })).toEqual({ mode: "link", reason: "too_large" });
    }
  });
  it("link reasons", () => {
    const t = { contentType: "application/pdf" };
    expect(plan({ ...t, size: 0 })).toEqual({ mode: "link", reason: "empty" });
    expect(plan({ ...t, size: 1, objectKey: "artifacts/other-conv/x" })).toEqual({
      mode: "link",
      reason: "foreign_key",
    });
    expect(
      plan({ ...t, size: 1 }, { features: { cards: true, edit: true, threads: true } }),
    ).toEqual({
      mode: "link",
      reason: "unsupported",
    });
    expect(plan({ ...t, size: 1 }, { canSendFile: false })).toEqual({
      mode: "link",
      reason: "unsupported",
    });
    expect(plan({ ...t, size: 1 }, { fileMaxBytes: 0 })).toEqual({
      mode: "link",
      reason: "disabled",
    });
  });
  it("too_large from either side; cap is the min", () => {
    const t = { contentType: "application/pdf" };
    expect(plan({ ...t, size: 100_001 })).toEqual({ mode: "link", reason: "too_large" });
    expect(plan({ ...t, size: 501 }, { fileMaxBytes: 500 })).toEqual({
      mode: "link",
      reason: "too_large",
    });
    expect(plan({ ...t, size: 500 }, { fileMaxBytes: 500 })).toMatchObject({ cap: 500 });
    expect(plan({ ...t, size: 500 })).toMatchObject({ cap: 100_000 });
  });
});

describe("formatFileSize", () => {
  it("formats", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2_411_724)).toBe("2.3 MB");
    expect(formatFileSize(1_073_741_824)).toBe("1.0 GB");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1_048_575)).toBe("1.0 MB");
    expect(formatFileSize(1_048_576)).toBe("1.0 MB");
    expect(formatFileSize(1_073_741_823)).toBe("1.0 GB");
  });
});

describe("fileLinkText / fileRootText", () => {
  const input = {
    name: "report.pdf",
    size: 2_411_724,
    artifactId: "a1",
    conversationId: "c1",
  };
  it("with and without a base", () => {
    expect(fileLinkText({ ...input, base: "https://cap.example", locale: "en" })).toBe(
      "`report.pdf` (2.3 MB) is in the web conversation: https://cap.example/chat/c1#file=a1",
    );
    expect(fileLinkText({ ...input, base: "https://cap.example", locale: "zh" })).toBe(
      "`report.pdf`（2.3 MB）在网页会话里：https://cap.example/chat/c1#file=a1",
    );
    expect(fileLinkText({ ...input, base: undefined, locale: "en" })).toBe(
      "`report.pdf` (2.3 MB) was delivered; open the conversation in Capybara on the web to get it.",
    );
  });
  it("names always appear as asCode(name)", () => {
    for (const name of ["a`b", "<@U1>", "https://evil.example", "$&x", "a\nb"]) {
      for (const base of ["https://cap.example", undefined]) {
        expect(fileLinkText({ ...input, name, base, locale: "en" })).toContain(asCode(name));
      }
      expect(fileRootText(name, "en")).toBe(`File ${asCode(name)}:`);
    }
  });
  it("the root text does not claim the upload succeeded (the link line may follow it)", () => {
    expect(fileRootText("chart.png", "en")).toBe("File `chart.png`:");
    expect(fileRootText("chart.png", "zh")).toBe("文件 `chart.png`：");
  });
});

describe("readArtifactCapped", () => {
  const signal = new AbortController().signal;
  it("ok, missing, too_large", async () => {
    const store = new MemoryObjectStore();
    store.objects.set("k", { data: new Uint8Array([1, 2, 3]), contentType: "x/y" });
    store.objects.set("big", { data: new Uint8Array(4), contentType: "x/y" });
    expect(await readArtifactCapped(store, "k", 3, signal)).toEqual({
      kind: "ok",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(await readArtifactCapped(store, "nope", 3, signal)).toEqual({ kind: "missing" });
    expect(await readArtifactCapped(store, "big", 3, signal)).toEqual({ kind: "too_large" });
  });
  it("a head larger than the cap cancels the body", async () => {
    let cancelled = false;
    const store = {
      async get() {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return { head: { key: "k", size: 11, contentType: "x/y" }, body };
      },
    } as unknown as ObjectStore;
    expect(await readArtifactCapped(store, "k", 10, signal)).toEqual({ kind: "too_large" });
    expect(cancelled).toBe(true);
  });
  it("a read that throws mid-stream cancels the reader and rethrows", async () => {
    let cancelled = false;
    const store = {
      async get() {
        const body = {
          getReader: () => ({
            read: async () => {
              throw new Error("ECONNRESET");
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        };
        return { head: { key: "k", size: 5, contentType: "x/y" }, body };
      },
    } as unknown as ObjectStore;
    await expect(readArtifactCapped(store, "k", 10, signal)).rejects.toThrow("ECONNRESET");
    expect(cancelled).toBe(true);
  });
  it("a body longer than its head cancels the reader", async () => {
    let cancelled = false;
    const store = {
      async get() {
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        });
        return { head: { key: "k", size: 10, contentType: "x/y" }, body };
      },
    } as unknown as ObjectStore;
    expect(await readArtifactCapped(store, "k", 10, signal)).toEqual({ kind: "too_large" });
    expect(cancelled).toBe(true);
  });
  it("unavailable maps; other errors rethrow", async () => {
    const mk = (e: unknown) =>
      ({
        async get() {
          throw e;
        },
      }) as unknown as ObjectStore;
    expect(await readArtifactCapped(mk(storageUnavailable()), "k", 5, signal)).toEqual({
      kind: "unavailable",
    });
    expect(
      await readArtifactCapped(mk(new ExtensionPointUnavailableError("x")), "k", 5, signal),
    ).toEqual({ kind: "unavailable" });
    await expect(readArtifactCapped(mk(new Error("ECONNRESET")), "k", 5, signal)).rejects.toThrow(
      "ECONNRESET",
    );
  });
});

describe("FileSlots", () => {
  const live = new AbortController().signal;
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await new Promise((r) => setImmediate(r));
    return done;
  };
  it("a third acquire waits for a release", async () => {
    const s = new FileSlots(2);
    const r1 = await s.acquire(live);
    await s.acquire(live);
    const third = s.acquire(live);
    expect(await settled(third)).toBe(false);
    r1();
    await third;
  });
  it("an aborted waiter leaks no slot", async () => {
    const s = new FileSlots(1);
    const r1 = await s.acquire(live);
    const ac = new AbortController();
    const w1 = s.acquire(ac.signal);
    const w2 = s.acquire(live);
    ac.abort(new Error("stop"));
    await expect(w1).rejects.toThrow("stop");
    expect(await settled(w2)).toBe(false);
    r1();
    await w2;
  });
  it("releasing twice frees one slot", async () => {
    const s = new FileSlots(1);
    const r1 = await s.acquire(live);
    r1();
    r1();
    const r2 = await s.acquire(live);
    const w = s.acquire(live);
    expect(await settled(w)).toBe(false);
    r2();
    await w;
  });
});

describe("channels file config", () => {
  const base = {
    db: { url: "postgres://u:p@localhost/db" },
    redis: { url: "redis://localhost:6379" },
    masterKey: Buffer.alloc(32, 1).toString("base64"),
  };
  it("defaults and validation", () => {
    const c = resolveConfig(base, {});
    expect(c.channels.fileMaxBytes).toBe(20_971_520);
    expect(c.channels.fileConcurrency).toBe(4);
    expect(
      resolveConfig(base, { CAPYBARA_CHANNELS__FILE_MAX_BYTES: "0" }).channels.fileMaxBytes,
    ).toBe(0);
    expect(() => resolveConfig(base, { CAPYBARA_CHANNELS__FILE_MAX_BYTES: "-1" })).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig(base, { CAPYBARA_CHANNELS__FILE_CONCURRENCY: "0" })).toThrow(
      ConfigError,
    );
  });
});

describe("pluginFileName", () => {
  it("replaces control characters and path separators, caps the length, never returns empty", () => {
    expect(pluginFileName("report.pdf")).toBe("report.pdf");
    expect(pluginFileName("a\nb\r\tc\u0000d\u007fe")).toBe("a b c d e");
    expect(pluginFileName("../etc\\passwd/x")).toBe(".._etc_passwd_x");
    expect(pluginFileName("  \n ")).toBe("file");
    expect(Array.from(pluginFileName("é".repeat(500)))).toHaveLength(200);
  });
});
