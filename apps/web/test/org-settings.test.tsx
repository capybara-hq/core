import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import OrganizationSettingsPage from "../src/app/[locale]/(app)/settings/organization/page";
import type { Me } from "../src/lib/session";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const SETTINGS = "/api/v1/orgs/o1/settings";

const actionRow = (locale: "zh" | "en") =>
  screen.queryByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("组织设置（SettingsPage）", () => {
  it.each(LOCALES)(
    "管理员：关闭工具搜索 → 出现 ActionRow → 保存 PATCH settings（%s）",
    async (locale) => {
      const m = msgs[locale];
      const o = m.orgSettings;
      const calls = stubApi({
        [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }),
        [`PATCH ${SETTINGS}`]: (c) => json(200, { settings: bodyOf(c) }),
      });
      const { container } = renderPage(<OrganizationSettingsPage />, { locale });
      expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
      // 二级导航与个人设置页一致，当前项为组织设置
      const current = container.querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.organization);
      expect(current?.getAttribute("href")).toBe("/settings/organization");
      const on = await screen.findByRole("radio", { name: new RegExp(`^${o.toolSearch.on}`) });
      expect(on).toHaveProperty("checked", true);
      expect(actionRow(locale)).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${o.toolSearch.off}`) }));
      const row = actionRow(locale);
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByRole("button", { name: o.save }));
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ toolSearch: "off" });
      expect(await screen.findByText(o.saved)).toBeTruthy();
      await vi.waitFor(() => expect(actionRow(locale)).toBeNull());
      expect(
        screen.getByRole("radio", { name: new RegExp(`^${o.toolSearch.off}`) }),
      ).toHaveProperty("checked", true);
    },
  );

  it("普通成员：只读（单选不可用、说明只有管理员能改），没有 ActionRow", async () => {
    stubApi({ [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "off" } }) });
    renderPage(<OrganizationSettingsPage />, { me: MEMBER });
    const off = await screen.findByRole("radio", {
      name: new RegExp(`^${en.orgSettings.toolSearch.off}`),
    });
    expect(off).toHaveProperty("checked", true);
    expect(off).toHaveProperty("disabled", true);
    expect(screen.getByText(en.orgSettings.readonly)).toBeTruthy();
    expect(actionRow("en")).toBeNull();
  });
});
