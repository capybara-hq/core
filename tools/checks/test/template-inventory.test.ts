import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { desktopOnlyPrefixes, inventoryTemplates } from "../src/template-inventory.js";

const dir = fileURLToPath(new URL("../fixtures/template-inventory", import.meta.url));

describe("template inventory", () => {
  it("lists one row per page.tsx with the templates its view and imported components draw", () => {
    expect(inventoryTemplates(dir)).toEqual([
      {
        route: "/admin/x",
        templates: ["DetailPage"],
        tabs: 0,
        dataTables: 1,
        audience: "super-admin",
      },
      {
        route: "/agents",
        templates: ["ListPage"],
        variant: "cards",
        tabs: 0,
        filtersKind: "segmented",
        dataTables: 0,
        audience: "member",
      },
    ]);
  });

  it("reads the desktop-only routes from nav.tsx", () => {
    expect(desktopOnlyPrefixes(dir)).toEqual(["/channels"]);
  });
});
