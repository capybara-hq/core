import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryPreviewEmbed } from "../src/components/extension-ui/LibraryPreviewEmbed";
import {
  FilePreviewBody,
  type FilePreviewBodyFrame,
} from "../src/components/file-preview/FilePreviewBody";
import { ShareDialog } from "../src/components/file-preview/ShareDialog";
import { type FileSource, sourceUrls } from "../src/lib/file-source";
import {
  deleteLibraryFile,
  getLibraryFile,
  type LibraryFileView,
  libraryFileText,
  libraryUsage,
  listLibraryFiles,
  uploadLibraryFile,
} from "../src/lib/library-files";
import { keys } from "../src/lib/query/keys";
import {
  libraryFileQuery,
  libraryFileSearchQuery,
  libraryFilesQuery,
  libraryUsageQuery,
} from "../src/lib/query/library";
import { useDeleteLibraryFile, useUploadLibraryFile } from "../src/lib/query/library-mutations";
import { useCreateLibraryShare } from "../src/lib/query/share-mutations";
import type { SharePolicy } from "../src/lib/shares";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const O = "/api/v1/orgs/o1";
const FILES = `${O}/files`;

const view = (id: string, extra: Partial<LibraryFileView> = {}): LibraryFileView => ({
  id,
  name: `${id}.txt`,
  contentType: "text/plain",
  size: 10,
  origin: "upload",
  agentId: null,
  sourceConversation: null,
  versions: 1,
  createdAt: "2026-11-28T06:00:00.000Z",
  previewable: "text",
  ...extra,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the library loaders", () => {
  it("list sends only the filters set, in a fixed order", async () => {
    const calls = stubApi({ [`GET ${FILES}`]: () => json(200, { files: [], next: null }) });
    await listLibraryFiles("o1");
    await listLibraryFiles("o1", {
      origin: "delivered",
      agentId: "a1",
      type: "document",
      q: " 报告 ",
      limit: 20,
      cursor: "n1",
    });
    expect(calls.map((c) => c.url)).toEqual([
      FILES,
      `${FILES}?origin=delivered&agentId=a1&type=document&q=%E6%8A%A5%E5%91%8A&limit=20&cursor=n1`,
    ]);
  });

  it("details, usage, delete and text hit the file-scoped routes", async () => {
    const calls = stubApi({
      [`GET ${FILES}/f1`]: () => json(200, { file: view("f1"), conversations: [], versions: [] }),
      [`GET ${FILES}/usage`]: () => json(200, { bytes: 10, files: 1 }),
      [`DELETE ${FILES}/f1`]: () => noContent(),
      [`GET ${FILES}/f1/content`]: () =>
        new Response("hello", { status: 200, headers: { "x-content-truncated": "true" } }),
    });
    expect((await getLibraryFile("o1", "f1")).file.id).toBe("f1");
    expect(await libraryUsage("o1")).toEqual({ bytes: 10, files: 1 });
    await deleteLibraryFile("o1", "f1");
    expect(await libraryFileText("o1", "f1")).toEqual({ text: "hello", truncated: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${FILES}/f1`,
      `GET ${FILES}/usage`,
      `DELETE ${FILES}/f1`,
      `GET ${FILES}/f1/content?limit=1048576`,
    ]);
  });

  it("an upload registers with purpose library; bytes the caller holds skip store and finalize", async () => {
    const calls = stubApi({
      [`POST ${FILES}`]: () =>
        json(201, {
          file: { id: "f9", name: "a.txt", contentType: "text/plain", size: 3, status: "ready" },
          upload: null,
          expiresAt: null,
        }),
    });
    const file = new File(["abc"], "a.txt", { type: "text/plain" });
    expect((await uploadLibraryFile("o1", file)).id).toBe("f9");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({
      name: "a.txt",
      contentType: "text/plain",
      size: 3,
      purpose: "library",
    });
  });

  it("the composer @ search reads ?q=&limit=8", async () => {
    const calls = stubApi({ [`GET ${FILES}`]: () => json(200, { files: [], next: null }) });
    const q = libraryFileSearchQuery("o1", "rep");
    expect(q.queryKey).toEqual(keys.org("o1").files({ q: "rep", limit: 8 }));
    await testQueryClient().fetchQuery(q);
    expect(calls[0]?.url).toBe(`${FILES}?q=rep&limit=8`);
  });

  it("every read lives under the org's scope", () => {
    for (const q of [
      libraryFilesQuery("o1", {}),
      libraryFileQuery("o1", "f1"),
      libraryUsageQuery("o1"),
    ]) {
      expect(q.queryKey.slice(0, 2)).toEqual(["org", "o1"]);
    }
  });
});

describe("library sourceUrls", () => {
  it("download, inline and content go through the library download route; no html route", () => {
    const s: FileSource = { kind: "library", orgId: "o1", file: view("f1") };
    expect(sourceUrls(s)).toEqual({
      download: `${FILES}/f1/download`,
      inline: `${FILES}/f1/download?inline=1`,
      content: `${FILES}/f1/download`,
    });
  });
});

/** Mounts a hook with a cache seeded with library, usage and conversation reads to watch refetch. */
function withSeededCache(routes: Parameters<typeof stubApi>[0]) {
  const client = testQueryClient();
  const calls = stubApi({
    [`GET ${FILES}`]: () => json(200, { files: [view("f1")], next: null }),
    [`GET ${FILES}/usage`]: () => json(200, { bytes: 10, files: 1 }),
    [`GET ${O}/conversations/c1/files`]: () => json(200, { files: [], next: null }),
    [`GET ${O}/shares`]: () => json(200, { shares: [] }),
    ...routes,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const watch = () => {
    useQuery(libraryFilesQuery("o1", {}));
    useQuery(libraryUsageQuery("o1"));
    useQuery({
      queryKey: keys.org("o1").conversation("c1").files(),
      queryFn: () => fetch(`${O}/conversations/c1/files`).then((r) => r.json() as Promise<unknown>),
      staleTime: Infinity,
    });
    useQuery({
      queryKey: keys.org("o1").conversation("c1").events(),
      queryFn: async () => [],
      staleTime: Infinity,
    });
  };
  return { client, calls, wrapper, watch };
}

const reads = (calls: { method: string; url: string }[], url: string) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === url).length;

describe("library mutations", () => {
  it("useDeleteLibraryFile invalidates the library lists, the usage and every conversation's files", async () => {
    const { client, calls, wrapper, watch } = withSeededCache({
      [`DELETE ${FILES}/f1`]: () => noContent(),
    });
    const { result } = renderHook(
      () => {
        watch();
        return useDeleteLibraryFile("o1");
      },
      { wrapper },
    );
    await waitFor(() => expect(reads(calls, `${O}/conversations/c1/files`)).toBe(1));
    await waitFor(() => expect(reads(calls, FILES)).toBe(1));
    await act(() => result.current.mutateAsync({ fileId: "f1" }));
    expect(reads(calls, FILES)).toBe(2);
    expect(reads(calls, `${FILES}/usage`)).toBe(2);
    expect(reads(calls, `${O}/conversations/c1/files`)).toBe(2);
    // the conversation's other reads are left alone
    expect(client.getQueryState(keys.org("o1").conversation("c1").events())?.isInvalidated).toBe(
      false,
    );
  });

  it("useUploadLibraryFile invalidates the library lists and the usage", async () => {
    const { calls, wrapper, watch } = withSeededCache({
      [`POST ${FILES}`]: () =>
        json(201, {
          file: { id: "f2", name: "b.txt", contentType: "text/plain", size: 1, status: "ready" },
          upload: null,
          expiresAt: null,
        }),
    });
    const { result } = renderHook(
      () => {
        watch();
        return useUploadLibraryFile("o1");
      },
      { wrapper },
    );
    await waitFor(() => expect(reads(calls, `${FILES}/usage`)).toBe(1));
    await act(() =>
      result.current.mutateAsync({ file: new File(["b"], "b.txt", { type: "text/plain" }) }),
    );
    expect(reads(calls, FILES)).toBe(2);
    expect(reads(calls, `${FILES}/usage`)).toBe(2);
    expect(reads(calls, `${O}/conversations/c1/files`)).toBe(1);
  });

  it("useCreateLibraryShare invalidates the share lists and every conversation's files", async () => {
    const { client, calls, wrapper, watch } = withSeededCache({
      [`POST ${FILES}/f1/shares`]: () => json(201, { share: { id: "sh1" } }),
    });
    client.setQueryData(keys.org("o1").libraryFileShares("f1"), { shares: [] });
    const { result } = renderHook(
      () => {
        watch();
        return useCreateLibraryShare("o1", "f1");
      },
      { wrapper },
    );
    await waitFor(() => expect(reads(calls, `${O}/conversations/c1/files`)).toBe(1));
    await act(() => result.current.mutateAsync({ audience: "internal", expiresInDays: null }));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      audience: "internal",
      expiresInDays: null,
    });
    expect(client.getQueryState(keys.org("o1").libraryFileShares("f1"))?.isInvalidated).toBe(true);
    expect(reads(calls, `${O}/conversations/c1/files`)).toBe(2);
    expect(reads(calls, FILES)).toBe(1);
  });
});

const frame = (f: FilePreviewBodyFrame) => (
  <section aria-label="body" data-state={f.state}>
    {f.children}
  </section>
);

describe("the file body for a library file", () => {
  const lib = (file: LibraryFileView): FileSource => ({ kind: "library", orgId: "o1", file });

  it("reads the library previewers, then the text of the built-in", async () => {
    const calls = stubApi({
      [`GET ${FILES}/f1/previewers`]: () => json(200, { previewers: [] }),
      [`GET ${FILES}/f1/content`]: () => new Response("hello library", { status: 200 }),
    });
    renderPage(
      <FilePreviewBody
        source={lib(view("f1"))}
        previewer={null}
        onDownload={() => {}}
        frame={frame}
      />,
    );
    expect(await screen.findByText("hello library")).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual([
      `${FILES}/f1/previewers`,
      `${FILES}/f1/content?limit=1048576`,
    ]);
  });

  it("an image shows inline through the library download route", async () => {
    stubApi({ [`GET ${FILES}/p1/previewers`]: () => json(200, { previewers: [] }) });
    renderPage(
      <FilePreviewBody
        source={lib(view("p1", { name: "p.png", contentType: "image/png", previewable: "image" }))}
        previewer={null}
        onDownload={() => {}}
        frame={frame}
      />,
    );
    expect((await screen.findByRole("img", { name: "p.png" })).getAttribute("src")).toBe(
      `${FILES}/p1/download?inline=1`,
    );
  });

  it("an HTML file frames the document token minted by the library route", async () => {
    const calls = stubApi({
      [`POST ${FILES}/h1/html-token`]: () =>
        json(200, { path: "/api/v1/html/tok-h", expiresIn: 300 }),
    });
    renderPage(
      <FilePreviewBody
        source={lib(view("h1", { name: "r.html", contentType: "text/html" }))}
        previewer={null}
        onDownload={() => {}}
        frame={frame}
      />,
    );
    expect((await screen.findByTitle("r.html")).getAttribute("src")).toBe("/api/v1/html/tok-h");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${FILES}/h1/html-token`]);
  });

  it("a view previewer renders through the library preview route", async () => {
    const calls = stubApi({
      [`GET ${FILES}/d1/previewers`]: () =>
        json(200, {
          previewers: [
            {
              plugin: "office",
              id: "doc",
              title: { zh: "文档", en: "Doc" },
              kind: "view",
              maxBytes: 1e7,
            },
          ],
        }),
      [`GET ${FILES}/d1/previews/office/doc`]: () =>
        json(200, { view: { blocks: [{ type: "text", markdown: "rendered doc" }] } }),
    });
    renderPage(
      <FilePreviewBody
        source={lib(
          view("d1", { name: "a.docx", contentType: "application/msword", previewable: null }),
        )}
        previewer={null}
        onDownload={() => {}}
        frame={frame}
      />,
    );
    expect(await screen.findByText("rendered doc")).toBeTruthy();
    expect(calls[1]?.url).toBe(`${FILES}/d1/previews/office/doc?locale=en`);
  });

  it("an embed previewer mints a token naming the file alone, no conversation", async () => {
    const calls = stubApi({
      [`GET ${FILES}/d2/previewers`]: () =>
        json(200, {
          previewers: [
            {
              plugin: "office",
              id: "docx",
              title: { zh: "Word", en: "Word" },
              kind: "embed",
              maxBytes: 1e7,
            },
          ],
        }),
      [`POST ${O}/ui/embeds/office/docx/token`]: () =>
        json(200, {
          token: "tok-1",
          src: "/plugin-ui/office/app",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          expiresIn: 300,
        }),
    });
    renderPage(
      <FilePreviewBody
        source={lib(
          view("d2", {
            name: "a.docx",
            contentType: "application/octet-stream",
            previewable: null,
          }),
        )}
        previewer={null}
        onDownload={() => {}}
        frame={frame}
        embed={(h) => <LibraryPreviewEmbed orgId="o1" fileId="d2" host={h} />}
      />,
    );
    expect((await screen.findByTitle("Word")).tagName).toBe("IFRAME");
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ fileId: "d2" });
  });
});

describe("the share dialog for a library file", () => {
  const ALLOWED: SharePolicy = { external: "allowed", maxExpiryDays: 30 };

  it("lists and creates through the library file's share routes", async () => {
    const calls = stubApi({
      [`GET ${FILES}/f1/shares`]: () => json(200, { shares: [], policy: ALLOWED }),
      [`POST ${FILES}/f1/shares`]: () =>
        json(201, {
          share: {
            id: "sh1",
            code: "AbCdEfGh12",
            url: "https://cap.example/s/AbCdEfGh12",
            audience: "internal",
            conversationId: null,
            fileId: "f1",
            sourcePath: null,
            name: "f1.txt",
            contentType: "text/plain",
            size: 10,
            generation: 1,
            createdBy: { id: "a1", displayName: "Grant", avatarUrl: null },
            createdAt: "2026-11-28T06:00:00.000Z",
            expiresAt: null,
            lastOpenedAt: null,
            state: "live",
            revokedAt: null,
            revokeReason: null,
            newerVersion: false,
          },
        }),
      [`GET ${O}/conversations/c1/files`]: () => json(200, { files: [], next: null }),
    });
    renderPage(
      <ShareDialog
        orgId="o1"
        target={{ kind: "library", file: view("f1") }}
        open
        onOpenChange={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create link" }));
    const field = await screen.findByRole("group", { name: "Link" });
    expect(field.querySelector("code")?.textContent).toBe("https://cap.example/s/AbCdEfGh12");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${FILES}/f1/shares`,
    ]);
    expect(calls.every((c) => !c.url.includes("/conversations/"))).toBe(true);
  });
});
