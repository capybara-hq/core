import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, Menu } from "../src/index";

afterEach(cleanup);

function renderMenu(onBeta: () => void) {
  render(
    <DesignProvider locale="zh">
      <Menu
        trigger={<button type="button">账户</button>}
        items={[
          {
            label: "切换组织",
            submenu: [
              { label: "Acme", checked: true, disabled: true, onSelect: vi.fn() },
              { label: "Beta", checked: false, onSelect: onBeta },
            ],
          },
          "separator",
          { label: "退出登录", onSelect: vi.fn() },
        ]}
      />
    </DesignProvider>,
  );
}

// jsdom has no layout, so moving the pointer from a submenu trigger into its submenu looks like
// leaving it; the tests pick submenu items with the keyboard (the path that needs no geometry).
describe("Menu submenus", () => {
  it("a submenu item opens a second level with its own checked choices", async () => {
    const onBeta = vi.fn();
    renderMenu(onBeta);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "账户" }));
    const trigger = screen.getByRole("menuitem", { name: "切换组织" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.querySelector("svg")).toBeTruthy();
    await user.click(trigger);
    const acme = await screen.findByRole("menuitemradio", { name: "Acme" });
    expect(acme.getAttribute("aria-checked")).toBe("true");
    expect(acme.getAttribute("aria-disabled")).toBe("true");
    const beta = screen.getByRole("menuitemradio", { name: "Beta" });
    beta.focus();
    await user.keyboard("{Enter}");
    expect(onBeta).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the right arrow opens the submenu from the keyboard", async () => {
    renderMenu(vi.fn());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "账户" }));
    screen.getByRole("menuitem", { name: "切换组织" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "Beta" })).toBeTruthy();
  });
});

describe("Menu head and foot", () => {
  it("draw non-interactive lines above the first item and below the last", async () => {
    render(
      <DesignProvider locale="zh">
        <Menu
          trigger={<button type="button">账户</button>}
          head="连接已断开"
          foot="v0.1.0 · UTC"
          items={[{ label: "退出登录", onSelect: vi.fn() }]}
        />
      </DesignProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "账户" }));
    const menu = screen.getByRole("menu");
    const head = menu.querySelector('[data-part="menu-head"]') as HTMLElement;
    const foot = menu.querySelector('[data-part="menu-foot"]') as HTMLElement;
    expect(head.textContent).toBe("连接已断开");
    expect(foot.textContent).toBe("v0.1.0 · UTC");
    expect(menu.firstElementChild).toBe(head);
    expect(menu.lastElementChild).toBe(foot);
    // only the item is a menu item; arrow keys never land on the lines
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(head.hasAttribute("tabindex")).toBe(false);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "退出登录" }));
  });
});
