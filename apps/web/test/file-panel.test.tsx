import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinPreview } from "../src/lib/files";
import { type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;

const file = (
  id: string,
  name: string,
  contentType: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  contentType,
  size: 1234,
  sourcePath: `/w/${name}`,
  version: 1,
  versions: [{ id, size: 1234, createdAt: "2026-10-26T06:00:00.000Z" }],
  callId: "call_1",
  createdAt: "2026-10-26T06:00:00.000Z",
  status: "available",
  previewable: null,
  origin: "delivered",
  ...extra,
});

const DOCX = file(
  "f1",
  "report.docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
);
const CSV = file("f2", "diff.csv", "text/csv", { previewable: "text" });
const PNG = file("f3", "chart.png", "image/png", { previewable: "image" });
const GONE = file("f4", "old.txt", "text/plain", { previewable: "text", status: "removed" });
/** A file a person sent with a message (an attachment). */
const SENT = file("a1", "brief.docx", DOCX.contentType, {
  origin: "uploaded",
  sourcePath: "brief.docx",
  callId: "",
});
const SENT_PNG = file("a2", "photo.png", "image/png", {
  origin: "uploaded",
  sourcePath: "photo.png",
  callId: "",
  previewable: "image",
});

function api(extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/events`]: () =>
      json(200, {
        events: [
          userMsg(1, "make files"),
          ev(2, "assistant_message", {
            step: 0,
            content: [{ type: "text", text: "Saved to `/w/diff.csv`." }],
            stopReason: "end_turn",
          }),
        ],
      }),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/files`]: () => json(200, { files: [DOCX, CSV, PNG, GONE], next: null }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${BASE}/files/f1/previewers`]: () => json(200, { previewers: [] }),
    [`GET ${BASE}/files/f2/previewers`]: () => json(200, { previewers: [] }),
    [`GET ${BASE}/files/f3/previewers`]: () => json(200, { previewers: [] }),
    [`GET ${BASE}/files/f2/content`]: () =>
      new Response("date,amount\n09-18,-109.51\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ...extra,
  });
}

const openAt = async (hash: string) => {
  window.history.replaceState(null, "", `/chat/c1${hash}`);
  await renderChatRoute();
};

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  window.history.replaceState(null, "", "/chat/c1");
});

describe("the file panel", () => {
  it("a .docx with an extension view previewer renders that previewer", async () => {
    api({
      [`GET ${BASE}/files/f1/previewers`]: () =>
        json(200, {
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
      [`GET ${BASE}/files/f1/previews/office/docx`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Quarterly report" }] } }),
    });
    openAt("#file=f1");
    const panel = await screen.findByRole("complementary", { name: "report.docx" });
    expect(await within(panel).findByText("Quarterly report")).toBeTruthy();
  });

  it("a .docx without a previewer shows the file card and Download", async () => {
    api();
    openAt("#file=f1");
    const panel = await screen.findByRole("complementary", { name: "report.docx" });
    expect(await within(panel).findByText(/No preview available/)).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: /Download/ }).length).toBeGreaterThan(0);
  });

  it("a .csv renders a table; the header switches between the conversation's files", async () => {
    api();
    openAt("#file=f2");
    const panel = await screen.findByRole("complementary", { name: "diff.csv" });
    expect(await within(panel).findByRole("table")).toBeTruthy();
    expect(within(panel).getByText("-109.51")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: /diff\.csv/ }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("chart.png"));
    const img = await screen.findByRole("img", { name: "chart.png" });
    expect(img.getAttribute("src")).toBe(`${BASE}/artifacts/f3/download?inline=1`);
    expect(window.location.hash).toBe("#file=f3");
  });

  it("a hash naming an older version still checks its file in the switcher (m9)", async () => {
    const two = file("f2", "diff.csv", "text/csv", {
      previewable: "text",
      version: 2,
      versions: [
        { id: "f2", size: 1234, createdAt: "2026-10-26T06:01:00.000Z" },
        { id: "f2-v1", size: 1000, createdAt: "2026-10-26T06:00:00.000Z" },
      ],
    });
    api({
      [`GET ${BASE}/files`]: () => json(200, { files: [DOCX, two, PNG], next: null }),
      [`GET ${BASE}/files/f2-v1/previewers`]: () => json(200, { previewers: [] }),
      [`GET ${BASE}/files/f2-v1/content`]: () =>
        new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    openAt("#file=f2-v1");
    const panel = await screen.findByRole("complementary", { name: "diff.csv" });
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: /diff\.csv/ }));
    const menu = await screen.findByRole("menu");
    const checked = within(menu)
      .getAllByRole("menuitemradio")
      .filter((i) => i.getAttribute("aria-checked") === "true");
    expect(checked.map((i) => i.textContent)).toEqual(["diff.csv"]);
  });

  it("a failing previewer shows Retry and the Download fallback in the panel only", async () => {
    let fail = true;
    api({
      [`GET ${BASE}/files/f2/content`]: () =>
        fail
          ? json(500, { error: { code: "internal", message: "x" } })
          : new Response("a,b\n1,2\n", { status: 200 }),
    });
    openAt("#file=f2");
    const panel = await screen.findByRole("complementary", { name: "diff.csv" });
    expect(await within(panel).findByText(/failed to load/)).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: /Download/ }).length).toBeGreaterThan(0);
    expect(screen.getByText("make files")).toBeTruthy();
    fail = false;
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByRole("table")).toBeTruthy();
  });

  it("a removed file shows the removed card", async () => {
    api();
    openAt("#file=f4");
    const panel = await screen.findByRole("complementary", { name: "old.txt" });
    expect(within(panel).getByText("No longer available")).toBeTruthy();
  });

  it("an uploaded file is marked in the switcher and downloads through the attachment route", async () => {
    const opened: { location: { href: string }; opener: unknown; close(): void }[] = [];
    vi.stubGlobal(
      "open",
      vi.fn(() => {
        const tab = { location: { href: "" }, opener: {} as unknown, close: () => {} };
        opened.push(tab);
        return tab;
      }),
    );
    api({
      [`GET ${BASE}/files`]: () => json(200, { files: [SENT, SENT_PNG, CSV], next: null }),
      [`GET ${BASE}/files/a1/previewers`]: () => json(200, { previewers: [] }),
      [`GET ${BASE}/files/a2/previewers`]: () => json(200, { previewers: [] }),
    });
    openAt("#file=a1");
    const panel = await screen.findByRole("complementary", { name: "brief.docx" });
    expect(await within(panel).findByText(/No preview available/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(panel).getAllByRole("button", { name: "Download" })[0] as HTMLElement);
    await vi.waitFor(() =>
      expect(opened[0]?.location.href).toMatch(new RegExp(`${ORG}/attachments/a1/download$`)),
    );
    await user.click(within(panel).getByRole("button", { name: /brief\.docx/ }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      "brief.docxUploaded",
      "photo.pngUploaded",
      "diff.csv",
    ]);
    await user.click(within(menu).getByText("photo.png"));
    const img = await screen.findByRole("img", { name: "photo.png" });
    expect(img.getAttribute("src")).toBe(`${ORG}/attachments/a2/download`);
  });

  it("a click on the panel's image opens the viewer; new tab opens the inline URL", async () => {
    const opened: { location: { href: string }; opener: unknown; close(): void }[] = [];
    vi.stubGlobal(
      "open",
      vi.fn(() => {
        const tab = { location: { href: "" }, opener: {} as unknown, close: () => {} };
        opened.push(tab);
        return tab;
      }),
    );
    api();
    openAt("#file=f3");
    const panel = await screen.findByRole("complementary", { name: "chart.png" });
    const user = userEvent.setup();
    await within(panel).findByRole("img", { name: "chart.png" });
    await user.click(panel.querySelector("button[data-part='preview-image']") as HTMLElement);
    const viewer = await screen.findByRole("dialog");
    expect(within(viewer).getByRole("img", { name: "chart.png" }).getAttribute("src")).toBe(
      `${BASE}/artifacts/f3/download?inline=1`,
    );
    await user.click(within(viewer).getByRole("button", { name: "Open in new tab" }));
    await vi.waitFor(() =>
      expect(opened[0]?.location.href).toMatch(/\/artifacts\/f3\/download\?inline=1$/),
    );
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a sent file opens in the panel once listed; one the list lacks yet downloads instead", async () => {
    const opened: { location: { href: string }; opener: unknown; close(): void }[] = [];
    vi.stubGlobal(
      "open",
      vi.fn(() => {
        const tab = { location: { href: "" }, opener: {} as unknown, close: () => {} };
        opened.push(tab);
        return tab;
      }),
    );
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "see these", {
              content: [
                { type: "text", text: "see these" },
                {
                  type: "document",
                  mediaType: "application/pdf",
                  source: { kind: "ref", attachmentId: "a1" },
                  name: "brief.pdf",
                },
                {
                  type: "document",
                  mediaType: "application/pdf",
                  source: { kind: "ref", attachmentId: "a9" },
                  name: "fresh.pdf",
                },
              ],
            }),
          ],
        }),
      [`GET ${BASE}/files`]: () =>
        json(200, { files: [{ ...SENT, name: "brief.pdf" }, CSV], next: null }),
      [`GET ${BASE}/files/a1/previewers`]: () => json(200, { previewers: [] }),
    });
    openAt("");
    const user = userEvent.setup();
    const log = await screen.findByRole("log");
    // listed: the right panel opens it
    await vi.waitFor(() => expect(window.location.hash).toBe(""));
    await user.click(await within(log).findByRole("button", { name: /brief\.pdf/ }));
    expect(await screen.findByRole("complementary", { name: "brief.pdf" })).toBeTruthy();
    expect(window.location.hash).toBe("#file=a1");
    expect(opened).toHaveLength(0);
    // not listed (yet): the click downloads it, never doing nothing
    await user.click(within(log).getByRole("button", { name: /fresh\.pdf/ }));
    await vi.waitFor(() =>
      expect(opened[0]?.location.href).toMatch(new RegExp(`${ORG}/attachments/a9/download$`)),
    );
    expect(window.location.hash).toBe("#file=a1");
  });

  it("a path in prose that names a file output is a chip opening the panel", async () => {
    api();
    openAt("");
    const chip = await screen.findByRole("button", { name: "/w/diff.csv" });
    await userEvent.setup().click(chip);
    expect(await screen.findByRole("complementary", { name: "diff.csv" })).toBeTruthy();
  });
});

describe("builtinPreview", () => {
  it("picks image, Markdown, CSV / TSV and text; null for other files", () => {
    const f = (name: string, contentType: string, previewable: "image" | "text" | null) => ({
      name,
      contentType,
      previewable,
    });
    expect(builtinPreview(f("a.png", "image/png", "image"))).toBe("image");
    expect(builtinPreview(f("a.md", "text/plain", "text"))).toBe("markdown");
    expect(builtinPreview(f("a.csv", "text/csv", "text"))).toBe("csv");
    expect(builtinPreview(f("a.tsv", "text/plain", "text"))).toBe("tsv");
    expect(builtinPreview(f("a.ts", "text/plain", "text"))).toBe("text");
    expect(builtinPreview(f("a.svg", "image/svg+xml", null))).toBeNull();
  });
});
