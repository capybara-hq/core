import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DangerZone, DangerZoneItem, DesignProvider, SecretReveal, StatusPage } from "../src/index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const header = { path: [{ label: "capybara" }], title: "渠道" };

describe("StatusPage kind=no-access (role pass)", () => {
  it("draws a lock instead of a code, the role it needs and who to ask; no action", () => {
    wrap(
      <StatusPage
        header={header}
        kind="no-access"
        title="没有访问权限"
        description="渠道只对组织管理员开放"
        need="组织管理员"
        ask="请联系组织的管理员或所有者"
      />,
    );
    const root = document.querySelector('[data-template="StatusPage"]');
    expect(root?.getAttribute("data-kind")).toBe("no-access");
    expect(document.querySelector('[data-part="status-lock"] svg')).toBeTruthy();
    expect(screen.queryByText("403")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "没有访问权限" })).toBeTruthy();
    expect(document.querySelector('[data-part="status-need"]')?.textContent).toBe(
      "需要：组织管理员",
    );
    expect(screen.getByText("请联系组织的管理员或所有者")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the need label follows the design locale", () => {
    wrap(
      <StatusPage
        header={header}
        kind="no-access"
        title="No access"
        description="x"
        need="Org admin"
      />,
      "en",
    );
    expect(document.querySelector('[data-part="status-need"]')?.textContent).toBe(
      "Requires: Org admin",
    );
  });
});

describe("DangerZone", () => {
  it("a labelled region with items, each a title, a description and one danger button", async () => {
    const onSelect = vi.fn();
    wrap(
      <DangerZone title="危险操作">
        <DangerZoneItem
          title="删除组织"
          description="删除后成员都将失去访问"
          action={{ label: "删除组织…", onSelect }}
        />
      </DangerZone>,
    );
    const region = screen.getByRole("region", { name: "危险操作" });
    expect(region.getAttribute("data-part")).toBe("danger-zone");
    expect(screen.getByText("删除后成员都将失去访问")).toBeTruthy();
    const button = screen.getByRole("button", { name: "删除组织…" });
    expect(button.getAttribute("data-variant")).toBe("danger");
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("SecretReveal", () => {
  it("shows the value once in a read-only mono field, copies it and says it is shown once", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    wrap(<SecretReveal label="令牌" value="cap_svc_abc" />);
    const field = screen.getByRole("textbox", { name: "令牌" }) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe("cap_svc_abc");
    expect(screen.getByText("只会显示这一次，请立即复制并妥善保存。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("cap_svc_abc");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
  });
});
