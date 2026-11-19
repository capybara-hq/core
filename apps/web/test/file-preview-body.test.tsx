import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilePreviewBody,
  type FilePreviewBodyFrame,
} from "../src/components/file-preview/FilePreviewBody";
import type { FileSource, ShareMeta } from "../src/lib/file-source";
import type { FileOutput } from "../src/lib/files";
import { json, stubApi } from "./support/api";
import { pageElement, renderPage } from "./support/render";

const frame = (f: FilePreviewBodyFrame) => (
  <section aria-label="body" data-state={f.state}>
    {f.children}
  </section>
);

const meta = (extra: Partial<ShareMeta> = {}): ShareMeta => ({
  name: "report.html",
  contentType: "text/html",
  size: 100,
  sharedBy: "Grant",
  expiresAt: null,
  audience: "external",
  render: "html",
  previewable: "text",
  previewers: [],
  ...extra,
});

const S = "/api/v1/s/AbCdEfGh12";
const share = (m: ShareMeta): FileSource => ({ kind: "share", code: "AbCdEfGh12", meta: m });

const body = (source: FileSource) => (
  <FilePreviewBody source={source} previewer={null} onDownload={() => {}} frame={frame} />
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the file body for a share", () => {
  it("render html frames the share's HTML route", async () => {
    stubApi({});
    renderPage(body(share(meta())));
    const iframe = await screen.findByTitle("report.html");
    expect(iframe.getAttribute("src")).toBe(`${S}/html`);
  });

  it("an HTML file the kernel renders as previewers shows its text, never the document", async () => {
    const calls = stubApi({
      [`GET ${S}/text`]: () => new Response("<h1>big</h1>", { status: 200 }),
    });
    renderPage(body(share(meta({ render: "previewers", size: 30 * 1024 * 1024 }))));
    expect(await screen.findByText("<h1>big</h1>")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(calls.every((c) => !c.url.endsWith("/html"))).toBe(true);
  });

  it("render download shows the card and reads nothing", async () => {
    const calls = stubApi({});
    renderPage(body(share(meta({ render: "download" }))));
    expect(await screen.findByText(/No preview available/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("the built-in follows meta.previewable, not a guess from the type", async () => {
    stubApi({});
    renderPage(
      body(
        share(
          meta({
            name: "a.png",
            contentType: "image/png",
            render: "previewers",
            previewable: "image",
          }),
        ),
      ),
    );
    expect((await screen.findByRole("img", { name: "a.png" })).getAttribute("src")).toBe(
      `${S}/inline`,
    );
    cleanup();
    // a text type the kernel does not serve as text: the card, no /text read
    const calls = stubApi({});
    renderPage(
      body(
        share(
          meta({
            name: "a.log",
            contentType: "text/plain",
            render: "previewers",
            previewable: null,
          }),
        ),
      ),
    );
    expect(await screen.findByText(/No preview available/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("the file body for a conversation file", () => {
  const file = (id: string): FileOutput => ({
    id,
    name: `${id}.html`,
    contentType: "text/html",
    size: 100,
    sourcePath: `/w/${id}.html`,
    version: 1,
    versions: [{ id, size: 100, createdAt: "2026-11-18T06:00:00.000Z" }],
    callId: "call_1",
    createdAt: "2026-11-18T06:00:00.000Z",
    status: "available",
    previewable: "text",
    origin: "delivered",
    shared: false,
  });
  const conv = (id: string): FileSource => ({
    kind: "conversation",
    orgId: "o1",
    conversationId: "c1",
    file: file(id),
  });
  const BASE = "/api/v1/orgs/o1/conversations/c1/files";

  it("a file switch never frames the previous file's token", async () => {
    let releaseB: (r: Response) => void = () => {};
    stubApi({
      [`POST ${BASE}/a/html-token`]: () =>
        json(200, { path: "/api/v1/html/tok-a", expiresIn: 300 }),
      [`POST ${BASE}/b/html-token`]: () =>
        new Promise<Response>((r) => {
          releaseB = r;
        }),
    });
    // every frame drawn records the document it shows: the render between the switch and the new
    // mint must not show a's document under b
    const drawn: { file: string; src: unknown }[] = [];
    const recording = (id: string) => (
      <FilePreviewBody
        source={conv(id)}
        previewer={null}
        onDownload={() => {}}
        frame={(f) => {
          const child = f.children as { props?: { src?: unknown } } | undefined;
          drawn.push({ file: id, src: child?.props?.src });
          return frame(f);
        }}
      />
    );
    const { rerender } = renderPage(recording("a"));
    expect((await screen.findByTitle("a.html")).getAttribute("src")).toBe("/api/v1/html/tok-a");
    rerender(pageElement(recording("b")));
    await vi.waitFor(() =>
      expect(screen.getByRole("region", { name: "body" }).getAttribute("data-state")).toBe(
        "loading",
      ),
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(drawn.filter((d) => d.file === "b" && d.src === "/api/v1/html/tok-a")).toEqual([]);
    releaseB(json(200, { path: "/api/v1/html/tok-b", expiresIn: 300 }));
    expect((await screen.findByTitle("b.html")).getAttribute("src")).toBe("/api/v1/html/tok-b");
  });
});
