import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRow,
  AppShell,
  Button,
  Card,
  CodeBlock,
  DesignProvider,
  IconButton,
  ImagePlaceholder,
  Input,
  Segmented,
  SIZE_CLASS_QUERIES,
  Sidebar,
  type SidebarProps,
  StatCards,
  Switch,
  UserBubble,
} from "../src/index";
import { UI_PART_NAMES } from "../src/ui-parts.generated";
import { matchMediaFor } from "./width";

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
          {...sidebarProps({
            brand,
            mode: "drawer",
            drawer: { open: true, onOpenChange: () => {} },
          })}
          drawerInline
        />
      </DesignProvider>,
    );
    expect(screen.queryByTestId("brand-rail")).toBeNull();
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

  it("AppShell publishes the sidebar mode and the size class: sidebar=rail|full, size=...", () => {
    const real = window.matchMedia;
    const stateAt = (px: number, collapsed?: boolean) => {
      window.matchMedia = matchMediaFor(px).matchMedia;
      const { container, unmount } = render(
        <DesignProvider locale="zh">
          <AppShell
            sidebar={sidebarProps()}
            {...(collapsed === undefined ? {} : { collapsed })}
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
      expect(stateAt(1440)).toBe("sidebar=full size=expanded");
      // the person's choice makes the expanded class the rail; the sidebar never does it by itself
      expect(stateAt(1100)).toBe("sidebar=full size=expanded");
      expect(stateAt(1100, true)).toBe("sidebar=rail size=expanded");
      expect(stateAt(700)).toBe("sidebar=rail size=medium");
      // the drawer (until the compact shell) counts as full
      expect(stateAt(500)).toBe("sidebar=full size=compact");
      // the shell reads the class queries from one place
      expect(SIZE_CLASS_QUERIES.compact).toBe("(max-width: 599px)");
      const shellSrc = readFileSync(
        resolve(import.meta.dirname, "../src/shell/app-shell.tsx"),
        "utf8",
      );
      expect(shellSrc).not.toMatch(/max-width: \d+px/);
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

  // The theme plugin round (2026-11-10): parts on the owning elements, never on a wrapper.
  it("the user bubble, code blocks, segmented controls, stat cards and switches carry their parts", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <UserBubble text="hi" />
        <CodeBlock text="ls" language="sh" />
        <Segmented
          label="view"
          value="a"
          onChange={() => {}}
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
        />
        <StatCards metrics={[{ label: "runs", value: 3 }]} />
        <Switch label="on" checked onChange={() => {}} />
        <Switch label="off" checked={false} onChange={() => {}} disabled />
      </DesignProvider>,
    );
    const row = container.querySelector('[data-cap-part="message.user"]') as HTMLElement;
    const bubble = row.querySelector('[data-cap-part="message.user.bubble"]') as HTMLElement;
    expect(bubble.textContent).toContain("hi");
    expect(bubble.getAttribute("data-part")).toBe("bubble");
    expect(container.querySelector('[data-cap-part="code-block"]')?.tagName).toBe("FIGURE");
    expect(screen.getByRole("radiogroup", { name: "view" }).getAttribute("data-cap-part")).toBe(
      "segmented",
    );
    expect(container.querySelectorAll('[data-cap-part="stat-card"]')).toHaveLength(1);
    const on = screen.getByRole("switch", { name: "on" });
    const off = screen.getByRole("switch", { name: "off" });
    expect(on.getAttribute("data-cap-part")).toBe("switch");
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect((off as HTMLButtonElement).disabled).toBe(true);
    // the knob is reachable as a child part of each switch
    expect(on.querySelector('[data-cap-part="switch.knob"]')).not.toBeNull();
    for (const token of parts()) expect(UI_PART_NAMES as readonly string[]).toContain(token);
  });

  it("the org switcher's initial block is org-avatar", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <Sidebar {...sidebarProps()} />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-cap-part="org-avatar"]')?.textContent).toBe("示");
  });

  it("the agents row's chips are agent-chip, the selected one aria-pressed", () => {
    render(
      <DesignProvider locale="zh">
        <AgentRow
          agents={[
            { id: "a1", name: "助手", avatar: null },
            { id: "a2", name: "塞尔达", avatar: null },
          ]}
          selected="a2"
          onSelect={() => {}}
        />
      </DesignProvider>,
    );
    const chips = [...document.querySelectorAll('[data-cap-part="agent-chip"]')];
    const name = (c: Element) => c.querySelector('[data-part="agent-chip-name"]')?.textContent;
    expect(chips.map((c) => [name(c), c.getAttribute("aria-pressed")])).toEqual([
      ["助手", "false"],
      ["塞尔达", "true"],
    ]);
  });
});

describe("image-placeholder part", () => {
  it("its token is in the catalog", () => {
    render(
      <DesignProvider locale="en">
        <ImagePlaceholder ratio={null} index={0} count={1} />
      </DesignProvider>,
    );
    expect(UI_PART_NAMES as readonly string[]).toContain("image-placeholder");
    expect([...parts()]).toEqual(["image-placeholder"]);
  });
});
