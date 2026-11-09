import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  Button,
  Card,
  DesignProvider,
  IconButton,
  Input,
  Sidebar,
  type SidebarProps,
} from "../src/index";
import { UI_PART_NAMES } from "../src/ui-parts.generated";

afterEach(cleanup);

const sidebarProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
  context: {
    kind: "work",
    org: { name: "示例组织", initial: "示", slug: "demo", role: "所有者", menu: [] },
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" }],
    inbox: { href: "/inbox", count: 0 },
    more: [],
  },
  newConversation: { href: "/chat" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
  onOpenCommands: vi.fn(),
  ...over,
});

const parts = (root: ParentNode = document) =>
  new Set(
    [...root.querySelectorAll("[data-cap-part]")].flatMap((el) =>
      (el.getAttribute("data-cap-part") ?? "").split(/\s+/),
    ),
  );

describe("data-cap-part (client extensions spec §7.1)", () => {
  it("every rendered token is a catalog part", () => {
    render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={sidebarProps()}
          status={{ context: "demo", version: "0.1.0", timeZone: "UTC" }}
        />
      </DesignProvider>,
    );
    for (const token of parts()) expect(UI_PART_NAMES as readonly string[]).toContain(token);
    expect([...parts()]).toEqual(
      expect.arrayContaining(["shell", "sidebar", "sidebar.brand", "sidebar.item", "status-bar"]),
    );
  });

  it("Sidebar draws the given brand instead of the Logo", () => {
    const { container, rerender } = render(
      <DesignProvider locale="zh">
        <Sidebar {...sidebarProps()} />
      </DesignProvider>,
    );
    const row = () => container.querySelector('[data-cap-part="sidebar.brand"]') as HTMLElement;
    expect(row().querySelector(".cb-logo")).not.toBeNull();
    rerender(
      <DesignProvider locale="zh">
        <Sidebar {...sidebarProps({ brand: () => <b data-testid="mine">MINE</b> })} />
      </DesignProvider>,
    );
    expect(row().querySelector(".cb-logo")).toBeNull();
    expect(screen.getByTestId("mine").closest('[data-cap-part="sidebar.brand"]')).toBe(row());
  });

  it("Sidebar calls brand once per drawn panel with that panel's variant", () => {
    const seen: string[] = [];
    const brand = (v: { collapsed: boolean; panel: string }) => {
      seen.push(`${v.panel}:${v.collapsed}`);
      return <b data-testid={`brand-${v.panel}`}>{v.collapsed ? "C" : "CAPY"}</b>;
    };
    const { unmount } = render(
      <DesignProvider locale="zh">
        <Sidebar {...sidebarProps({ brand, mode: "rail" })} />
      </DesignProvider>,
    );
    expect(screen.getByTestId("brand-rail").textContent).toBe("C");
    expect(screen.queryByTestId("brand-full")).toBeNull();
    unmount();
    seen.length = 0;
    render(
      <DesignProvider locale="zh">
        <Sidebar {...sidebarProps({ brand, mode: "full" })} />
      </DesignProvider>,
    );
    expect(screen.getByTestId("brand-full").textContent).toBe("CAPY");
    expect(new Set(seen)).toEqual(new Set(["full:false"]));
  });

  it("Sidebar's drawer draws brand uncollapsed", () => {
    const brand = (v: { collapsed: boolean; panel: string }) => (
      <b data-testid={`brand-${v.panel}`}>{String(v.collapsed)}</b>
    );
    render(
      <DesignProvider locale="zh">
        <Sidebar
          {...sidebarProps({ brand, mode: "rail", drawer: { open: true, onOpenChange: () => {} } })}
          drawerInline
        />
      </DesignProvider>,
    );
    expect(screen.getByTestId("brand-rail").textContent).toBe("true");
    expect(screen.getByTestId("brand-drawer").textContent).toBe("false");
  });

  it("AppShell renders capState as data-cap-state on the shell element", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={sidebarProps()}
          status={{ context: "demo", version: "0.1.0", timeZone: "UTC" }}
          capState="run=idle theme=builtin"
        />
      </DesignProvider>,
    );
    const shell = container.querySelector('[data-cap-part~="shell"]') as HTMLElement;
    // jsdom has no matchMedia: the wide window, so the full sidebar.
    expect(shell.getAttribute("data-cap-state")).toBe("run=idle theme=builtin sidebar=full");
  });

  it("AppShell publishes the sidebar mode as sidebar=rail|full (the drawer counts as full)", () => {
    const real = window.matchMedia;
    const widthOf = (px: number) =>
      ((query: string) => {
        const max = /max-width: (\d+)px/.exec(query)?.[1];
        return {
          matches: max !== undefined && px <= Number(max),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
      }) as unknown as typeof window.matchMedia;
    const stateAt = (px: number) => {
      window.matchMedia = widthOf(px);
      const { container, unmount } = render(
        <DesignProvider locale="zh">
          <AppShell
            sidebar={sidebarProps()}
            status={{ context: "demo", version: "0.1.0", timeZone: "UTC" }}
          />
        </DesignProvider>,
      );
      const v = (container.querySelector('[data-cap-part~="shell"]') as HTMLElement).getAttribute(
        "data-cap-state",
      );
      unmount();
      return v;
    };
    try {
      expect(stateAt(1440)).toBe("sidebar=full");
      expect(stateAt(1100)).toBe("sidebar=rail");
      expect(stateAt(800)).toBe("sidebar=full");
    } finally {
      window.matchMedia = real;
    }
  });

  it("a primary Button carries button and button.primary; the others only button", () => {
    render(
      <DesignProvider locale="zh">
        <Button variant="primary">go</Button>
        <Button>plain</Button>
        <Input aria-label="n" />
        <Card title="t">c</Card>
      </DesignProvider>,
    );
    expect(screen.getByRole("button", { name: "go" }).getAttribute("data-cap-part")).toBe(
      "button button.primary",
    );
    expect(screen.getByRole("button", { name: "plain" }).getAttribute("data-cap-part")).toBe(
      "button",
    );
    expect(parts()).toEqual(new Set(["button", "button.primary", "input", "card"]));
  });

  it("an IconButton is a button too (the composer's send and stop among them)", () => {
    render(
      <DesignProvider locale="zh">
        <IconButton label="send" icon={null} part="send" />
        <IconButton label="go" icon={null} variant="primary" />
      </DesignProvider>,
    );
    const send = screen.getByRole("button", { name: "send" });
    expect(send.getAttribute("data-cap-part")).toBe("button");
    // its own data-part stays (the design's styling and the app's tests read it)
    expect(send.getAttribute("data-part")).toBe("send");
    expect(screen.getByRole("button", { name: "go" }).getAttribute("data-cap-part")).toBe(
      "button button.primary",
    );
  });
});
