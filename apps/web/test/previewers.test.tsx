import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ExtensionsPage from "../src/app/[locale]/(app)/settings/extensions/page";
import {
  createEmbedBridge,
  EMBED_PROTOCOL,
  type EmbedBridgeOptions,
  type EmbedParentMessage,
} from "../src/lib/embed-bridge";
import { type OrgFilePreviewer, reorder } from "../src/lib/previewers";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** UI refresh B Task 11: file previewers on the web (bridge `file` message, org order section). */

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function bridge(over: Partial<EmbedBridgeOptions> = {}) {
  const frame = {};
  const posted: EmbedParentMessage[] = [];
  const b = createEmbedBridge({
    post: (m) => posted.push(m),
    frameWindow: () => frame,
    fetchToken: async () => ({ token: "tok", expiresIn: 300 }),
    locale: "en",
    context: { orgId: "o1", conversationId: "c1" },
    readTheme: () => ({ theme: "dark", tokens: {} }),
    onResize: vi.fn(),
    onNavigate: vi.fn(),
    onToast: vi.fn(),
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    ...over,
  });
  return { b, posted };
}

describe("embed bridge: the file of a file-preview embed", () => {
  it("sends one file message after init, never before load and never twice", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const file = vi.fn(async () => ({ name: "a.docx", contentType: "x/y", size: 3, data }));
    const { b, posted } = bridge({ file });
    await b.start();
    await flush();
    expect(posted).toEqual([]);
    b.loaded();
    await flush();
    expect(posted.map((m) => m.type)).toEqual(["init", "file"]);
    expect(posted[1]).toEqual({
      protocol: EMBED_PROTOCOL,
      type: "file",
      name: "a.docx",
      contentType: "x/y",
      size: 3,
      data,
    });
    b.themeChanged();
    await flush();
    expect(posted.filter((m) => m.type === "file")).toHaveLength(1);
    expect(file).toHaveBeenCalledTimes(1);
  });

  it("other embeds (no file) get no file message", async () => {
    const { b, posted } = bridge();
    await b.start();
    b.loaded();
    await flush();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
  });

  it("a failed file read is reported, not posted", async () => {
    const onFileError = vi.fn();
    const { b, posted } = bridge({
      file: async () => {
        throw new Error("gone");
      },
      onFileError,
    });
    await b.start();
    b.loaded();
    await flush();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
    expect(onFileError).toHaveBeenCalledTimes(1);
  });
});

const BASE = "/api/v1/orgs/o1";
const P = (id: string, position: number, disabled = false): OrgFilePreviewer => ({
  plugin: "docs",
  id,
  title: { zh: `中-${id}`, en: `En-${id}` },
  kind: "view",
  accepts: { extensions: [".docx"] },
  maxBytes: 1024,
  position,
  disabled,
});

describe("reorder", () => {
  it("swaps neighbours and ignores moves past the ends", () => {
    const items = [P("a", 0), P("b", 1, true)];
    expect(reorder(items, 1, -1)).toEqual([
      { plugin: "docs", id: "b", disabled: true },
      { plugin: "docs", id: "a", disabled: false },
    ]);
    expect(reorder(items, 0, -1).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

beforeEach(() => resetNavigation("/settings/extensions"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("org file previewers section", () => {
  it.each(["zh", "en"] as const)("moves and disables previewers with PUT (%s)", async (locale) => {
    const m = (locale === "zh" ? zh : en).filePreviewers;
    const calls = stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [] }),
      [`GET ${BASE}/file-previewers`]: () => json(200, { items: [P("a", 0), P("b", 1)] }),
      [`PUT ${BASE}/file-previewers`]: (c) => {
        const items = (bodyOf(c) as { items: { id: string; disabled: boolean }[] }).items;
        return json(200, { items: items.map((i, n) => P(i.id, n, i.disabled)) });
      },
    });
    renderPage(<ExtensionsPage />, { locale });
    const section = await screen.findByRole("region", { name: m.title });
    const user = userEvent.setup();
    await user.click(
      within(section).getByRole("button", {
        name: m.moveUp.replace("{name}", `${locale === "zh" ? "中" : "En"}-b`),
      }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        items: [
          { plugin: "docs", id: "b", disabled: false },
          { plugin: "docs", id: "a", disabled: false },
        ],
      }),
    );
    const name = `${locale === "zh" ? "中" : "En"}-a`;
    await user.click(
      await within(section).findByRole("switch", { name: m.enableLabel.replace("{name}", name) }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({
        items: [
          { plugin: "docs", id: "b", disabled: false },
          { plugin: "docs", id: "a", disabled: true },
        ],
      }),
    );
  });

  it("is hidden when no enabled extension provides a previewer", async () => {
    stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [] }),
      [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    });
    renderPage(<ExtensionsPage />, { locale: "en" });
    await screen.findByText(en.extensions.empty);
    expect(screen.queryByRole("region", { name: en.filePreviewers.title })).toBeNull();
  });
});
