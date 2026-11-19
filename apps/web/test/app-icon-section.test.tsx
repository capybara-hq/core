// Mobile layout spec §10.2.1: the super admin's 应用图标 section on /admin/settings: a row per
// purpose with its preview, upload (the file as base64 JSON) and 恢复默认.

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { AppIconSection } from "../src/components/AppIconSection";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, noContent, stubApi } from "./support/api";
import { renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const T = en.appIcon;
const SHA = "d".repeat(64);
const APP_ICON = {
  purpose: "app",
  url: `/api/v1/platform/icon/app?v=${SHA}`,
  sha256: SHA,
  updatedAt: "2026-11-19T08:00:00.000Z",
};

/** A PNG header that says 512 × 512 (enough for the upload; the kernel checks the real file). */
function png512(): File {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(16, 512);
  new DataView(bytes.buffer).setUint32(20, 512);
  return new File([bytes], "icon.png", { type: "image/png" });
}

const base64Of = async (f: File) => Buffer.from(await f.arrayBuffer()).toString("base64");

let icons: (typeof APP_ICON)[];
let calls: Call[];

const routes = (put?: (c: Call) => Response) => {
  calls = stubApi({
    "GET /api/v1/admin/platform/icons": () => json(200, { icons }),
    "PUT /api/v1/admin/platform/icons/app": (c) => {
      if (put) return put(c);
      icons = [APP_ICON];
      return json(200, APP_ICON);
    },
    "DELETE /api/v1/admin/platform/icons/app": () => {
      icons = [];
      return noContent();
    },
  });
};

const rowOf = async (title: string) =>
  (await screen.findByText(title, { selector: "*" })).closest("li") as HTMLElement;

beforeEach(() => {
  icons = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppIconSection", () => {
  it("lists the three icons with the web's defaults as previews when nothing is uploaded", async () => {
    routes();
    renderPage(<AppIconSection />);
    expect(await screen.findByRole("heading", { name: T.title })).toBeTruthy();
    for (const p of ["app", "maskable", "favicon"] as const) {
      const row = await rowOf(T[p].title);
      expect(within(row).getByText(new RegExp(T.default))).toBeTruthy();
      expect(within(row).queryByRole("button", { name: T.restore })).toBeNull();
    }
    const img = (await rowOf(T.app.title)).querySelector("img");
    expect(img?.getAttribute("src")).toBe("/icon-512.png");
  });

  it("uploading a 512 PNG calls PUT …/icons/app with the base64 file and invalidates the icons and the meta", async () => {
    routes();
    const client = testQueryClient();
    renderPage(<AppIconSection />, { client });
    client.setQueryData(keys.deployment().platformMeta(), { name: null });
    const row = await rowOf(T.app.title);
    const input = row.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/png");
    const file = png512();
    await userEvent.setup().upload(input, file);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      contentType: "image/png",
      dataBase64: await base64Of(file),
    });
    // the icons read again (invalidated) and show the upload
    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/api/v1/admin/platform/icons").length).toBe(2),
    );
    expect(client.getQueryState(keys.deployment().platformMeta())?.isInvalidated).toBe(true);
    const updated = await rowOf(T.app.title);
    await waitFor(() =>
      expect(updated.querySelector("img")?.getAttribute("src")).toBe(APP_ICON.url),
    );
    expect(within(updated).getByRole("button", { name: T.restore })).toBeTruthy();
  });

  it("a kernel platform_icon.invalid_size shows its copy", async () => {
    routes(() =>
      json(400, { error: { code: "platform_icon.invalid_size", message: "must be 512 x 512" } }),
    );
    renderPage(<AppIconSection />);
    const row = await rowOf(T.app.title);
    await userEvent
      .setup()
      .upload(row.querySelector('input[type="file"]') as HTMLInputElement, png512());
    expect(await screen.findByText(en.errors.platform_icon.invalid_size)).toBeTruthy();
  });

  it("a file over 1 MiB is refused before it is sent", async () => {
    routes();
    renderPage(<AppIconSection />);
    const row = await rowOf(T.app.title);
    const big = new File([new Uint8Array(1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await userEvent
      .setup()
      .upload(row.querySelector('input[type="file"]') as HTMLInputElement, big);
    expect(await screen.findByText(en.errors.platform_icon.too_large)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("恢复默认 calls DELETE and invalidates the icons", async () => {
    icons = [APP_ICON];
    routes();
    const client = testQueryClient();
    renderPage(<AppIconSection />, { client });
    const row = await rowOf(T.app.title);
    await userEvent.setup().click(await within(row).findByRole("button", { name: T.restore }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(within(row).queryByRole("button", { name: T.restore })).toBeNull());
    expect(calls.filter((c) => c.url === "/api/v1/admin/platform/icons").length).toBe(2);
  });

  it("the favicon row takes an SVG", async () => {
    routes();
    renderPage(<AppIconSection />);
    const row = await rowOf(T.favicon.title);
    expect(row.querySelector('input[type="file"]')?.getAttribute("accept")).toBe("image/svg+xml");
  });
});
