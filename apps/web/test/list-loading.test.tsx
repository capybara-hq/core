import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminCatalogPage from "../src/app/(app)/admin/catalog/page";
import AdminExtensionsPage from "../src/app/(app)/admin/extensions/page";
import AgentsPage from "../src/app/(app)/agents/page";
import CatalogPage from "../src/app/(app)/catalog/page";
import ChannelsPage from "../src/app/(app)/channels/page";
import ConnectorsPage from "../src/app/(app)/connectors/page";
import EvalsPage from "../src/app/(app)/evals/page";
import SkillsPage from "../src/app/(app)/skills/page";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

// Web order final review I5: an object list page shows skeleton rows (a busy list), not an empty
// bordered panel, until its first answer.

beforeEach(() => {
  // every read stays pending: the pages stay in their first load
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pages: [string, string, () => ReactNode][] = [
  ["agents", "/agents", () => <AgentsPage />],
  ["skills", "/skills", () => <SkillsPage />],
  ["connectors", "/connectors", () => <ConnectorsPage />],
  ["catalog", "/catalog", () => <CatalogPage />],
  ["channels", "/channels", () => <ChannelsPage />],
  ["evals", "/evals", () => <EvalsPage />],
  ["admin extensions", "/admin/extensions", () => <AdminExtensionsPage />],
  ["admin catalog", "/admin/catalog", () => <AdminCatalogPage />],
];

describe("object list pages while loading", () => {
  it.each(pages)("%s: skeleton rows in a busy list", async (_name, path, page) => {
    resetNavigation(path);
    renderPage(page());
    const busy = await vi.waitFor(() => {
      const el = document.querySelector('.cb-object-list[aria-busy="true"]');
      if (el === null) throw new Error("no busy object list");
      return el;
    });
    expect(busy.querySelectorAll('[data-skeleton="true"]').length).toBeGreaterThan(0);
    expect(screen.getAllByText("Loading").length).toBeGreaterThan(0);
  });
});
