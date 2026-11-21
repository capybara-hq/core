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
  orgMenu: [
    { label: "Meta1", checked: true, onSelect: () => {} },
    { label: "Beta", checked: false, onSelect: () => {} },
  ],
  personalSettingsHref: "/account/profile",
  theme: {
    label: "外观",
    value: "dark",
    lightLabel: "浅色",
    darkLabel: "深色",
    onChange: () => {},
  },
  status: "grant@meta1:~/chat · v0.1.0 · UTC+8",
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
  it("groups the rows (maintainer decision 2026-11-22): profile, org, preferences, sign out", () => {
    render(<Harness d={data()} />);
    const groups = [
      ...(sheet() as HTMLElement).querySelectorAll(
        '[data-part$="-group"], [data-part="account-preferences"]',
      ),
    ].map((g) => g.getAttribute("data-part"));
    expect(groups).toEqual([
      "account-profile-group",
      "account-org-group",
      "account-preferences",
      "account-sign-out-group",
    ]);
    const s = within(sheet() as HTMLElement);
    expect(s.getByRole("button", { name: /组织/ }).textContent).toContain("Meta1");
    expect(s.getByRole("radiogroup", { name: "外观" })).toBeTruthy();
    expect(s.queryByRole("button", { name: "切换平台" })).toBeNull();
  });

  it("the profile row opens 个人设置; there is no separate 个人设置 row", () => {
    render(<Harness d={data()} />);
    const profile = (sheet() as HTMLElement).querySelector('[data-part="account-profile"]');
    expect(profile?.tagName).toBe("A");
    expect(profile?.getAttribute("href")).toBe("/account/profile");
    expect(profile?.textContent).toContain("Grant");
    expect(profile?.textContent).toContain("个人资料与偏好设置");
    expect(within(sheet() as HTMLElement).queryByText("个人设置")).toBeNull();
  });

  it("with one org the 组织 row shows its name and is not a control", () => {
    const { orgMenu: _, ...one } = data();
    render(<Harness d={one} />);
    const org = (sheet() as HTMLElement).querySelector('[data-part="account-org"]') as HTMLElement;
    expect(org.tagName).toBe("DIV");
    expect(org.textContent).toContain("Meta1");
    expect(org.querySelector(".cb-icon[data-icon='chevron-right'], svg + svg")).toBeNull();
    expect(within(sheet() as HTMLElement).queryByRole("button", { name: /组织/ })).toBeNull();
  });

  it("sign out sits alone in its group; the status line is the footnote, not a row", () => {
    render(<Harness d={data()} />);
    const out = (sheet() as HTMLElement).querySelector('[data-part="account-sign-out-group"]');
    expect(out?.children).toHaveLength(1);
    expect(out?.textContent).toBe("退出登录");
    const status = (sheet() as HTMLElement).querySelector('[data-part="account-status"]');
    expect(status?.tagName).toBe("P");
    expect(status?.closest(".cb-sheet-group")).toBeNull();
    expect(status?.textContent).toBe("grant@meta1:~/chat · v0.1.0 · UTC+8");
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

  it("the 语言 row shows the current language and opens its choice (the phone's only switch)", async () => {
    const pick = vi.fn();
    render(
      <Harness
        d={data({
          language: { value: "中文", label: "语言", items: [{ label: "English", onSelect: pick }] },
        })}
      />,
    );
    const row = (sheet() as HTMLElement).querySelector(
      '[data-part="account-language"]',
    ) as HTMLElement;
    expect(row.textContent).toContain("语言");
    expect(row.textContent).toContain("中文");
    await userEvent.click(row);
    await userEvent.click(await screen.findByRole("menuitem", { name: "English" }));
    expect(pick).toHaveBeenCalledTimes(1);
    // a pick closes the sheet (and the drawer under it, through onDone)
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it("an org pick closes the sheet", async () => {
    const pick = vi.fn();
    render(<Harness d={data({ orgMenu: [{ label: "Beta", checked: false, onSelect: pick }] })} />);
    await userEvent.click(screen.getByRole("button", { name: /组织/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    expect(pick).toHaveBeenCalledTimes(1);
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
