import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DateTime,
  DesignProvider,
  EmptyState,
  formatDateTime,
  KeyValue,
  Menu,
  ObjectList,
  ObjectRow,
  SettingsPage,
  Text,
  versionLabel,
} from "../src/index";

afterEach(cleanup);
const zh = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("type roles (spec §2.2)", () => {
  it("Text variant prose is running text in the proportional font", () => {
    zh(<Text variant="prose">这段说明是一句话。</Text>);
    expect(screen.getByText("这段说明是一句话。").getAttribute("data-variant")).toBe("prose");
  });
});

describe("dates and versions", () => {
  const iso = new Date(2026, 10, 2, 23, 42, 7).toISOString();

  it("formatDateTime: full YYYY-MM-DD HH:mm, compact MM-DD HH:mm, local time", () => {
    expect(formatDateTime(iso)).toBe("2026-11-02 23:42");
    expect(formatDateTime(iso, "compact")).toBe("11-02 23:42");
    expect(formatDateTime(new Date(2026, 0, 5, 7, 3).toISOString())).toBe("2026-01-05 07:03");
  });

  it("DateTime: a mono <time> with the machine value and the relative age on hover", () => {
    zh(<DateTime value={iso} />);
    const el = screen.getByText("2026-11-02 23:42");
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe(iso);
    expect(el.getAttribute("title")).toMatch(/前|天/);
  });

  it("versionLabel: always a leading v, never two", () => {
    expect(versionLabel("0.1.0-rc.0")).toBe("v0.1.0-rc.0");
    expect(versionLabel("v2.0.0")).toBe("v2.0.0");
    expect(versionLabel(3)).toBe("v3");
  });
});

describe("label/value grids", () => {
  it("KeyValue columns=2 lays pairs out in two columns", () => {
    zh(
      <KeyValue
        columns={2}
        rows={[
          { k: "Agents", v: "1" },
          { k: "技能", v: "0" },
        ]}
      />,
    );
    const dl = document.querySelector("dl.cb-kv") as HTMLElement;
    expect(dl.getAttribute("data-columns")).toBe("2");
    // the key keeps its natural width in a grid (no fixed 8ch)
    expect((dl.querySelector(".cb-kv-key") as HTMLElement).style.width).toBe("");
  });
});

describe("avatar tiles (one rule: the upper-cased first grapheme)", () => {
  it("ObjectRow draws the initial of mark.text upper-cased", () => {
    zh(
      <ObjectList label="l">
        <ObjectRow mark={{ text: "openai-compatible" }} name="openai-compatible" />
        <ObjectRow mark={{ text: "研究助手" }} name="研究助手" />
      </ObjectList>,
    );
    const marks = Array.from(document.querySelectorAll(".cb-object-mark")).map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(["O", "研"]);
  });
});

describe("empty states: one page style and one compact style", () => {
  it("compact is the sentence alone: no illustration, no icon", () => {
    zh(<EmptyState size="compact" text="没有匹配的会话。" />);
    const el = document.querySelector('[data-part="empty-state"]') as HTMLElement;
    expect(el.querySelector('[data-part="empty-illustration"]')).toBeNull();
    expect(el.querySelector('[data-part="empty-state-icon"]')).toBeNull();
    expect(el.querySelector(".cb-icon")).toBeNull();
  });

  it("page is the line-art capybara with the sentence", () => {
    zh(<EmptyState text="还没有 agent。" />);
    const el = document.querySelector('[data-part="empty-state"]') as HTMLElement;
    expect(el.querySelector('[data-part="empty-illustration"] svg')).not.toBeNull();
  });
});

describe("menus", () => {
  it("an item may carry an icon, drawn before its label", async () => {
    zh(
      <Menu
        trigger={<button type="button">打开</button>}
        items={[{ label: "技能", href: "/skills", icon: "skills" }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    const item = await screen.findByRole("menuitem", { name: "技能" });
    expect(item.querySelector(".cb-icon")).not.toBeNull();
  });

  it("a menu opening below its trigger is at least as wide as the trigger", async () => {
    zh(
      <Menu
        trigger={<button type="button">打开</button>}
        items={[{ label: "a", onSelect() {} }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("data-match-trigger")).toBe("true");
  });
});

describe("SettingsPage on phones", () => {
  it("the sub-nav is one row of items (a compact control), marked for the narrow layout", () => {
    zh(
      <SettingsPage
        header={{ path: [{ label: "capybara" }], title: "设置" }}
        nav={[
          { group: "组织", items: [{ id: "org", label: "组织", href: "/o" }] },
          { group: "安全", items: [{ id: "tokens", label: "令牌", href: "/t" }] },
        ]}
        activeNav="tokens"
      >
        <p>content</p>
      </SettingsPage>,
    );
    const nav = screen.getByRole("navigation", { name: "设置导航" });
    expect(nav.getAttribute("data-part")).toBe("settings-nav");
    expect(within(nav).getAllByRole("link")).toHaveLength(2);
  });
});
