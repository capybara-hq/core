// @vitest-environment jsdom
import { DesignProvider } from "@capybara-hq/design";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_DESIGN, PageCrumbsProvider } from "../src/components/client-ext/host-api";
import { DESIGN_SUBSET } from "../src/lib/client-host/api.generated";

afterEach(cleanup);

describe("forwarded templates", () => {
  it("the host map has an entry for every name of the design subset", () => {
    expect(DESIGN_SUBSET.filter((n) => !(n in HOST_DESIGN) && n !== "ViewBlocks")).toEqual([]);
  });

  it("a template's path line starts with the host's crumbs, then the plugin's own", () => {
    const ListPage = HOST_DESIGN.ListPage as unknown as React.ComponentType<{
      header: { title: string; path?: { label: string }[] };
      children?: React.ReactNode;
    }>;
    render(
      <DesignProvider locale="en">
        <PageCrumbsProvider value={[{ label: "Acme" }, { label: "Tracker" }]}>
          <ListPage header={{ title: "Items", path: [{ label: "Open" }] }}>rows</ListPage>
        </PageCrumbsProvider>
      </DesignProvider>,
    );
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Acme")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Acme")).toBeLessThan(text.indexOf("Tracker"));
    expect(text.indexOf("Tracker")).toBeLessThan(text.indexOf("Open"));
    expect(screen.getByRole("heading", { name: "Items" })).toBeTruthy();
  });
});
