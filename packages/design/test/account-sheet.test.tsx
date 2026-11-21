// The account sheet (design spec §6.54): the drawer's account row opens it.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSheet, type AccountSheetData, DesignProvider } from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const data = (over: Partial<AccountSheetData> = {}): AccountSheetData => ({
  name: "Grant",
  orgName: "Meta1",
  orgSwitcher: <button type="button">切换组织</button>,
  personalSettingsHref: "/account/profile",
  theme: <button type="button">深色</button>,
  status: <span>系统正常</span>,
  onSignOut: () => {},
  ...over,
});

function Harness({ d }: { d: AccountSheetData }) {
  const [open, setOpen] = useState(true);
  return (
    <DesignProvider locale="zh">
      <AccountSheet open={open} onOpenChange={setOpen} data={d} />
    </DesignProvider>
  );
}
const sheet = () => document.querySelector('[data-part="account-sheet"]') as HTMLElement | null;

describe("AccountSheet", () => {
  it("holds the person, the org switcher, 个人设置, the theme, the status and sign out", () => {
    render(<Harness d={data()} />);
    const s = within(sheet() as HTMLElement);
    expect(s.getByText("Grant")).toBeTruthy();
    expect(s.getByText("Meta1")).toBeTruthy();
    expect(s.getByRole("button", { name: "切换组织" })).toBeTruthy();
    expect(s.getByRole("link", { name: "个人设置" }).getAttribute("href")).toBe("/account/profile");
    expect(s.getByRole("button", { name: "深色" })).toBeTruthy();
    expect(s.getByText("系统正常")).toBeTruthy();
    expect(s.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(s.queryByRole("button", { name: "切换平台" })).toBeNull();
  });

  it("「切换平台」 only with onSwitchProfile, and it calls it", async () => {
    const onSwitchProfile = vi.fn();
    render(<Harness d={data({ onSwitchProfile })} />);
    await userEvent.click(screen.getByRole("button", { name: "切换平台" }));
    expect(onSwitchProfile).toHaveBeenCalledTimes(1);
  });

  it("sign out calls onSignOut and closes the sheet", async () => {
    const onSignOut = vi.fn();
    render(<Harness d={data({ onSignOut })} />);
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it("a 语言 line holds the language control (T28 review: the phone's only language switch)", () => {
    render(<Harness d={data({ language: <button type="button">中文</button> })} />);
    const line = (sheet() as HTMLElement).querySelector(
      '[data-part="account-language"]',
    ) as HTMLElement;
    expect(within(line).getByText("语言")).toBeTruthy();
    expect(within(line).getByRole("button", { name: "中文" })).toBeTruthy();
  });

  it("a slot given as a function gets done(), which closes the sheet (an org switch, a language pick)", async () => {
    render(
      <Harness
        d={data({
          orgSwitcher: (done) => (
            <button type="button" onClick={done}>
              切到 Beta
            </button>
          ),
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "切到 Beta" }));
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it("outside an org there is no org line", () => {
    render(<Harness d={data({ orgName: null })} />);
    expect(within(sheet() as HTMLElement).queryByText("Meta1")).toBeNull();
  });

  it("draws no nested box", () => {
    render(<Harness d={data()} />);
    expect(findNestedBoxes(document.body)).toEqual([]);
  });
});
