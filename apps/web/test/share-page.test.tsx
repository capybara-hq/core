import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ShareView from "../src/app/(auth)/s/[code]/view";
import type { ShareMeta } from "../src/lib/file-source";
import { type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const CODE = "AbCdEfGh12";
const PAGE = `/s/${CODE}`;
const S = `/api/v1/s/${CODE}`;

const meta = (extra: Partial<ShareMeta> = {}): ShareMeta => ({
  name: "report.html",
  contentType: "text/html",
  size: 100,
  sharedBy: "Grant",
  expiresAt: null,
  audience: "external",
  previewable: "text",
  render: "html",
  previewers: [],
  ...extra,
});

const notFound = () => json(404, { error: { code: "share.not_found", message: "x" } });
const signInRequired = () => json(401, { error: { code: "share.sign_in_required", message: "x" } });

/** The page loads no workspace data: no org route, no session, no conversation list. */
const noWorkspaceReads = (calls: Call[]) => {
  for (const c of calls) {
    expect(c.url).not.toMatch(/^\/api\/v1\/(orgs|me|conversations)\b/);
  }
};

beforeEach(() => {
  resetNavigation(PAGE);
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the share page /s/[code]", () => {
  it("render html frames the share's HTML route in the SharedFilePage, with no shell", async () => {
    const calls = stubApi({ [`GET ${S}`]: () => json(200, meta()) });
    const { container, calls: server } = await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(container.querySelector('[data-template="SharedFilePage"]')).not.toBeNull();
    const frame = await vi.waitFor(() => {
      const f = container.querySelector("iframe");
      if (f === null) throw new Error("no frame yet");
      return f;
    });
    expect(frame.getAttribute("title")).toBe("report.html");
    expect(frame.getAttribute("src")).toBe(`${S}/html`);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    expect(screen.getByRole("heading", { name: "report.html" })).toBeTruthy();
    expect(screen.getByText("Shared by Grant · never expires")).toBeTruthy();
    // no sidebar, no navigation of a workspace
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector('[data-template="AppShell"]')).toBeNull();
    noWorkspaceReads([...server, ...calls]);
  });

  it("the bar says who shared it and when it expires, in zh too", async () => {
    stubApi({ [`GET ${S}`]: () => json(200, meta({ expiresAt: "2026-11-25T00:00:00.000Z" })) });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale: "zh" });
    expect(await screen.findByText(/^Grant 分享 · .*过期$/)).toBeTruthy();
    expect(zh.shares.page.sharedBy).toBe("{name} 分享");
  });

  it("render previewers with a view previewer shows the view the share route rendered", async () => {
    const calls = stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "report.docx",
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            render: "previewers",
            previewable: null,
            previewers: [
              {
                plugin: "office",
                id: "docx",
                title: { zh: "Word", en: "Word" },
                kind: "view",
                maxBytes: 1e7,
              },
            ],
          }),
        ),
      [`GET ${S}/previews/office/docx`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Quarterly report" }] } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText("Quarterly report")).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith(`${S}/previews/office/docx?locale=en`))).toBe(true);
    noWorkspaceReads(calls);
  });

  it("an embed previewer is hosted by EmbedTab in share mode: the share token, scope share, no navigation", async () => {
    const calls = stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "report.docx",
            contentType: "application/octet-stream",
            render: "previewers",
            previewable: null,
            previewers: [
              {
                plugin: "file-preview",
                id: "docx",
                title: { zh: "Word", en: "Word" },
                kind: "embed",
                maxBytes: 1e7,
              },
            ],
          }),
        ),
      [`POST ${S}/embed-token/file-preview/docx`]: () =>
        json(200, { token: "tok-s", src: "/plugin-ui/file-preview/app", expiresIn: 300 }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const frame = (await screen.findByTitle("Word")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("/plugin-ui/file-preview/app");
    expect(frame.getAttribute("data-fill")).toBe("true");
    const mint = calls.filter((c) => c.url === `${S}/embed-token/file-preview/docx`);
    expect(mint).toHaveLength(1);
    expect(mint[0]?.method).toBe("POST");
    const win = frame.contentWindow as Window;
    const sent: unknown[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
      sent.push(m);
    });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(sent[0]).toEqual(
      expect.objectContaining({ type: "init", token: "tok-s", context: { scope: "share" } }),
    );
    const fromFrame = (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, source: win }));
      });
    // a toast proves the frame's messages reach the bridge; a navigate is ignored (no app here)
    await vi.waitFor(() => {
      fromFrame({ protocol: "capybara-embed/1", type: "toast", text: "Rendered" });
      expect(screen.getByText("Rendered")).toBeTruthy();
    });
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "/chat/c9" });
    expect(router.push).not.toHaveBeenCalled();
    noWorkspaceReads(calls);
  });

  it("a view previewer that declines the share gives way to the next one, then the built-in", async () => {
    const declined = () =>
      json(502, { error: { code: "ui.render_failed", message: "needs the conversation" } });
    const view = (plugin: string, id: string) => ({
      plugin,
      id,
      title: { zh: id, en: id },
      kind: "view" as const,
      maxBytes: 1e7,
    });
    const calls = stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "a.csv",
            contentType: "text/csv",
            render: "previewers",
            previewers: [view("chat", "needs-conv"), view("sheets", "grid")],
          }),
        ),
      [`GET ${S}/previews/chat/needs-conv`]: declined,
      [`GET ${S}/previews/sheets/grid`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Grid view" }] } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText("Grid view")).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith(`${S}/previews/chat/needs-conv`))).toBe(true);
    // a decline is not a failure: no Retry on the page
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();

    // every extension previewer declines: the built-in shows the text
    const more = stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "a.csv",
            contentType: "text/csv",
            render: "previewers",
            previewers: [view("chat", "needs-conv")],
          }),
        ),
      [`GET ${S}/previews/chat/needs-conv`]: declined,
      [`GET ${S}/text`]: () => new Response("city,count\nParis,3\n", { status: 200 }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText("Paris")).toBeTruthy();
    expect(more.some((c) => c.url.startsWith(`${S}/previews/chat/needs-conv`))).toBe(true);
  });

  it("a view previewer that fails otherwise shows Retry with the Download fallback", async () => {
    stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "a.bin",
            contentType: "application/octet-stream",
            render: "previewers",
            previewable: null,
            previewers: [
              {
                plugin: "x",
                id: "slow",
                title: { zh: "slow", en: "slow" },
                kind: "view",
                maxBytes: 1e7,
              },
            ],
          }),
        ),
      [`GET ${S}/previews/x/slow`]: () =>
        json(504, { error: { code: "ui.timeout", message: "timed out" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a declining previewer with nothing after it leaves the file card with Download", async () => {
    stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "a.bin",
            contentType: "application/octet-stream",
            render: "previewers",
            previewable: null,
            previewers: [
              {
                plugin: "chat",
                id: "needs-conv",
                title: { zh: "c", en: "c" },
                kind: "view",
                maxBytes: 1e7,
              },
            ],
          }),
        ),
      [`GET ${S}/previews/chat/needs-conv`]: () =>
        json(502, { error: { code: "ui.render_failed", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText(/No preview available/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Download/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a CSV with only the built-in reads the share's text route", async () => {
    const calls = stubApi({
      [`GET ${S}`]: () =>
        json(200, meta({ name: "a.csv", contentType: "text/csv", render: "previewers" })),
      [`GET ${S}/text`]: () => new Response("city,count\nParis,3\n", { status: 200 }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText("Paris")).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith(`${S}/text`))).toBe(true);
  });

  it("an image shows the share's inline route", async () => {
    stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "a.png",
            contentType: "image/png",
            render: "previewers",
            previewable: "image",
          }),
        ),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const img = await screen.findByRole("img", { name: "a.png" });
    expect(img.getAttribute("src")).toBe(`${S}/inline`);
  });

  it("render download shows the file card; Download fetches the attachment route", async () => {
    stubApi({
      [`GET ${S}`]: () =>
        json(
          200,
          meta({
            name: "data.bin",
            contentType: "application/octet-stream",
            render: "download",
            previewable: null,
          }),
        ),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText(/No preview available/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /Download/ });
    // the bar's Download and the card's
    expect(buttons.length).toBe(2);
    const user = userEvent.setup();
    for (const b of buttons) await user.click(b);
    expect(navigateBrowser.mock.calls).toEqual([
      [`${S}/content?download=1`],
      [`${S}/content?download=1`],
    ]);
  });

  it.each(["en", "zh"] as const)(
    "an invalid link is the one StatusPage 404 (%s)",
    async (locale) => {
      const m = { en, zh }[locale];
      const calls = stubApi({ [`GET ${S}`]: notFound });
      const { container } = await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
      expect(container.querySelector('[data-template="StatusPage"]')).not.toBeNull();
      expect(container.querySelector('[data-kind="404"]')).not.toBeNull();
      expect(screen.getAllByText(m.shares.page.invalidTitle).length).toBeGreaterThan(0);
      expect(screen.getByText(m.shares.page.invalidBody)).toBeTruthy();
      expect(container.querySelector("iframe")).toBeNull();
      noWorkspaceReads(calls);
    },
  );

  // A document load is redirected by the segment layout first (auth-layout.test.tsx).
  it("an internal link without a session signs in first (client render)", async () => {
    stubApi({ [`GET ${S}`]: signInRequired });
    renderPage(<ShareView code={CODE} />);
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(`/login?returnTo=%2Fs%2F${CODE}`),
    );
  });

  it("another failure shows Retry in the page, which reads again", async () => {
    let down = true;
    stubApi({
      [`GET ${S}`]: () =>
        down ? json(500, { error: { code: "internal", message: "x" } }) : json(200, meta()),
    });
    const { container } = renderPage(<ShareView code={CODE} />);
    expect(await screen.findByText("Shared file failed to load")).toBeTruthy();
    down = false;
    await userEvent.setup().click(screen.getByRole("button", { name: /Retry/ }));
    await vi.waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe(`${S}/html`),
    );
  });

  it("the page is not indexed and sends no referrer", async () => {
    const { metadata } = await import("../src/app/(auth)/s/[code]/page");
    expect(metadata).toMatchObject({
      robots: { index: false, follow: false },
      referrer: "no-referrer",
    });
  });
});
