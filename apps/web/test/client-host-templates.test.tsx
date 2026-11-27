// @vitest-environment jsdom
import { DesignProvider } from "@capybara-hq/design";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_DESIGN, PageCrumbsProvider } from "../src/components/client-ext/host-api";
import { DESIGN_SUBSET } from "../src/lib/client-host/api.generated";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type PageProps = {
  header: {
    title: string;
    path?: { label: string; href?: string }[];
    actions?: unknown[];
    tabs?: unknown[];
  };
  children?: ReactNode;
};
const ListPage = HOST_DESIGN.ListPage as unknown as ComponentType<PageProps>;

/** The path line's labels in document order (the crumbs, then the heading). */
const textOrder = (...labels: string[]) => {
  const text = document.body.textContent ?? "";
  return labels.map((l) => text.indexOf(l));
};

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

  it("without host crumbs (outside a plugin page) the path is the plugin's own", () => {
    render(
      <DesignProvider locale="en">
        <ListPage
          header={{
            title: "Items",
            path: [{ label: "Here" }, { label: "There" }, { label: "Where" }],
          }}
        />
      </DesignProvider>,
    );
    const [here, there, where] = textOrder("Here", "There", "Where");
    expect(here).toBe(0);
    expect(here).toBeLessThan(there as number);
    expect(there).toBeLessThan(where as number);
  });

  it("a template without a header is a host error naming it, not a TypeError", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Bare = ListPage as unknown as ComponentType<Record<string, never>>;
    expect(() =>
      render(
        <DesignProvider locale="en">
          <Bare />
        </DesignProvider>,
      ),
    ).toThrow(/ListPage: `header` is required/);
  });
});

describe("links in forwarded components", () => {
  it("same-origin paths and http(s) URLs pass; javascript:, data: and other schemes are dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ItemListItem = HOST_DESIGN.ItemListItem as unknown as ComponentType<{
      title: string;
      href?: string;
    }>;
    const EmptyState = HOST_DESIGN.EmptyState as unknown as ComponentType<{
      text: string;
      action?: { label: string; href: string };
    }>;
    render(
      <DesignProvider locale="en">
        <PageCrumbsProvider value={[{ label: "Acme", href: "/" }]}>
          <ListPage
            header={{
              title: "Items",
              path: [
                { label: "Ok", href: "/p/tracker/items?x=1" },
                { label: "Evil", href: "javascript:alert(1)" },
              ],
              actions: [{ label: "Docs", href: "https://docs.example/a" }],
            }}
          >
            <ItemListItem title="Data" href="data:text/html,hi" />
            <ItemListItem title="Proto" href="//evil.example/x" />
            <ItemListItem title="Tab" href={"/\t/evil.example"} />
            <ItemListItem title="Fine" href="/p/tracker/items" />
            <EmptyState text="none" action={{ label: "Mail", href: "mailto:a@b.c" }} />
          </ListPage>
        </PageCrumbsProvider>
      </DesignProvider>,
    );
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/p/tracker/items?x=1",
        "https://docs.example/a",
        "/p/tracker/items",
      ]),
    );
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "//evil.example/x",
      "mailto:a@b.c",
    ]) {
      expect(hrefs).not.toContain(bad);
    }
    expect(hrefs.some((h) => h?.includes("evil"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped the link "javascript:alert(1)"'),
    );
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("standalone Tabs and the empty states of ListPage and ItemList have their links checked", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Tabs = HOST_DESIGN.Tabs as unknown as ComponentType<{
      label: string;
      value: string;
      items: { id: string; label: string; href?: string }[];
    }>;
    const EmptyList = HOST_DESIGN.ListPage as unknown as ComponentType<
      PageProps & { empty?: { text: string; action?: { label: string; href: string } } }
    >;
    const ItemList = HOST_DESIGN.ItemList as unknown as ComponentType<{
      label: string;
      rows: unknown[];
      empty?: { text: string; action?: { label: string; href: string } };
    }>;
    render(
      <DesignProvider locale="en">
        <Tabs
          label="Views"
          value="a"
          items={[
            { id: "a", label: "A", href: "/p/tracker/a" },
            { id: "b", label: "B", href: "javascript:alert(2)" },
          ]}
        />
        <ItemList
          label="Rows"
          rows={[]}
          empty={{ text: "No rows", action: { label: "Add", href: "data:text/html,x" } }}
        />
        <EmptyList
          header={{ title: "Empty" }}
          empty={{ text: "Nothing", action: { label: "Go", href: "vbscript:x" } }}
        />
      </DesignProvider>,
    );
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/p/tracker/a");
    for (const bad of ["javascript:alert(2)", "data:text/html,x", "vbscript:x"]) {
      expect(hrefs).not.toContain(bad);
    }
    for (const where of ["Tabs", "ItemList", "ListPage"]) {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${where}: dropped`)));
    }
  });
});
