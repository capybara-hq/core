import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  Button,
  Card,
  DesignProvider,
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
        <Sidebar {...sidebarProps({ brand: <b data-testid="mine">MINE</b> })} />
      </DesignProvider>,
    );
    expect(row().querySelector(".cb-logo")).toBeNull();
    expect(screen.getByTestId("mine").closest('[data-cap-part="sidebar.brand"]')).toBe(row());
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
    expect(shell.getAttribute("data-cap-state")).toBe("run=idle theme=builtin");
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
});
