import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { activeNavOf, type NavLevel, useNav } from "../src/components/shell/nav";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

afterEach(cleanup);

function Probe({ level, enterprise }: { level: NavLevel; enterprise: boolean }) {
  const { nav, footerNav } = useNav(0, level, false, enterprise);
  return (
    <pre data-testid="ids">
      {JSON.stringify({ nav: nav.map((n) => n.id), footer: footerNav.map((n) => n.id) })}
    </pre>
  );
}

function ids(level: NavLevel, enterprise: boolean) {
  render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <Probe level={level} enterprise={enterprise} />
    </NextIntlClientProvider>,
  );
  return JSON.parse(screen.getByTestId("ids").textContent ?? "{}") as {
    nav: string[];
    footer: string[];
  };
}

describe("nav by level (role hiding is cosmetic; the kernel decides)", () => {
  const guest = ["overview", "agents", "inbox", "connectors"];
  const member = ["overview", "agents", "skills", "inbox", "connectors", "catalog"];
  const admin = [...member.slice(0, 5), "catalog", "channels", "evals"];
  const cases: [NavLevel, boolean, string[], string[]][] = [
    ["guest", false, guest, ["settings"]],
    ["member", false, member, ["settings"]],
    ["admin", false, admin, ["settings"]],
    ["guest", true, guest, ["settings", "admin"]],
    ["member", true, member, ["settings", "admin"]],
    ["admin", true, admin, ["settings", "admin"]],
  ];
  for (const [level, enterprise, nav, footer] of cases) {
    it(`${level}${enterprise ? " + enterprise admin" : ""}`, () => {
      expect(ids(level, enterprise)).toEqual({ nav, footer });
    });
  }

  it("every item has an icon; settings links to /settings/connections", () => {
    function Icons() {
      const { nav, footerNav } = useNav(0, "admin", false, true);
      return (
        <pre data-testid="icons">
          {JSON.stringify([...nav, ...footerNav].map((n) => [n.id, n.icon, n.href]))}
        </pre>
      );
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Icons />
      </NextIntlClientProvider>,
    );
    expect(JSON.parse(screen.getByTestId("icons").textContent ?? "[]")).toEqual([
      ["overview", "home", "/"],
      ["agents", "agent", "/agents"],
      ["skills", "skills", "/skills"],
      ["inbox", "inbox", "/inbox"],
      ["connectors", "connector", "/connectors"],
      ["catalog", "catalog", "/catalog"],
      ["channels", "channel", "/channels"],
      ["evals", "evals", "/evals"],
      ["settings", "settings", "/settings/connections"],
      ["admin", "admin", "/admin"],
    ]);
  });
});

describe("activeNavOf", () => {
  it.each([
    ["/settings/members", "settings"],
    ["/settings/connections", "settings"],
    ["/chat/abc", ""],
    ["/agents/a1", "agents"],
    ["/connectors/c1", "connectors"],
    ["/trajectories/x", "evals"],
    ["/", "overview"],
    // an extension page is its sidebar item (m1), decoded like the item ids
    ["/p/example-board/board", "ext:example-board/board"],
    ["/p/%40acme%2Fboard/main%20view", "ext:@acme/board/main view"],
  ])("%s → %s", (path, id) => {
    expect(activeNavOf(path)).toBe(id);
  });
});
