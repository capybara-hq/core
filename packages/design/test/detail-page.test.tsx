import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, DetailPage, DeviceNameplate } from "../src/index";

afterEach(cleanup);

const templates = readFileSync(resolve(import.meta.dirname, "../src/styles/templates.css"), "utf8");
const shell = readFileSync(resolve(import.meta.dirname, "../src/styles/shell.css"), "utf8");
const ruleIn = (css: string, selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
    css,
  )?.[1] ?? "";

const zh = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const header = {
  path: [{ label: "capybara" }, { label: "devices" }, { label: "MacBook-Pro.local" }],
  title: "MacBook-Pro.local",
  actions: [{ label: "重命名", variant: "default" as const, onSelect: () => {} }],
};
const tabs = {
  items: [
    { id: "overview", label: "概览" },
    { id: "settings", label: "设置" },
  ],
  value: "overview",
  label: "设备视图",
};

/**
 * The band form of a detail page (spec §4.2, §5.2, accepted 2026-11-14): the page's first block is
 * its own name band, so the band is the head's last row and the page's tabs follow it.
 */
describe("DetailPage, the band form", () => {
  it("draws the band as the head's last row and the tab row under it, before the content", () => {
    const { container } = zh(
      <DetailPage
        header={{ ...header, titleHidden: true }}
        facts={<DeviceNameplate name="MacBook-Pro.local" origin="local" state="online" />}
        tabs={{ ...tabs, onChange: () => {} }}
      >
        <p>内容</p>
      </DetailPage>,
    );
    // no title row; the name stays an h1 for assistive tech
    expect(container.querySelector('[data-part="page-header-row"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "MacBook-Pro.local" })).toBeTruthy();
    const band = container.querySelector(".cb-detail-band") as HTMLElement;
    const order = [...band.children].map((c) => c.className);
    expect(order).toEqual([
      "cb-detail-band-facts",
      "cb-pageheader-tabs cb-detail-band-tabs",
      "cb-detail-band-content",
    ]);
    expect(band.querySelector('[data-part="device-nameplate"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "概览" })).toBeTruthy();
    // the head itself carries no tab row (the template drew it after the band)
    expect(container.querySelector('[data-part="template-head"] .cb-pageheader-tabs')).toBeNull();
    expect(
      (container.querySelector('[data-part="template-head"]') as HTMLElement).getAttribute(
        "data-band",
      ),
    ).toBe("true");
  });

  it("keeps the standard order when the page keeps its title row", () => {
    const { container } = zh(
      <DetailPage header={header} facts={<p>事实</p>} tabs={{ ...tabs, onChange: () => {} }}>
        <p>内容</p>
      </DetailPage>,
    );
    const head = container.querySelector('[data-part="template-head"]') as HTMLElement;
    expect(head.querySelector('[data-part="page-tabs"]')).toBeTruthy();
    expect(head.getAttribute("data-band")).toBeNull();
    expect(container.querySelector(".cb-detail-band")).toBeNull();
  });

  it("draws a band-shaped skeleton for a page whose band is not known yet", () => {
    const { container } = zh(
      <DetailPage
        header={{ ...header, titleHidden: true, title: "", loading: { actions: 1 } }}
        tabs={tabs}
        loading={{ band: true, content: [{ kind: "lines", lines: 2 }] }}
      />,
    );
    const skeleton = container.querySelector('[data-part="detail-band-skeleton"]');
    expect(skeleton).toBeTruthy();
    // no KeyValue placeholder where the band goes
    expect(container.querySelector('[data-part="detail-facts"] dl')).toBeNull();
  });

  it("spaces the band, the tab row and the content with the form's three steps", () => {
    expect(ruleIn(templates, ".cb-detail-band-facts")).toMatch(
      /margin-top:\s*var\(--cb-layout-head-path\)/,
    );
    expect(ruleIn(templates, ".cb-detail-band-tabs")).toMatch(/margin-top:\s*var\(--cb-space-2\)/);
    expect(ruleIn(templates, ".cb-detail-band-content")).toMatch(
      /margin-top:\s*var\(--cb-space-4\)/,
    );
    // the head ends with the path row: no head-content padding below it
    expect(ruleIn(shell, '.cb-template-head[data-band="true"]')).toMatch(/padding-bottom:\s*0/);
    // the skeleton keeps the loaded band's height
    expect(ruleIn(templates, ".cb-detail-band-skeleton")).toMatch(/min-height:\s*70px/);
  });

  it("takes no tabs as a page with one view (band, then content)", () => {
    const { container } = zh(
      <DetailPage
        header={{ ...header, titleHidden: true }}
        facts={<DeviceNameplate name="MacBook-Pro.local" origin="local" state="offline" />}
      >
        <p>内容</p>
      </DetailPage>,
    );
    const band = container.querySelector(".cb-detail-band") as HTMLElement;
    expect(band.getAttribute("data-tabs")).toBeNull();
    expect(band.querySelector(".cb-detail-band-tabs")).toBeNull();
    expect([...band.children].map((c) => c.className)).toEqual([
      "cb-detail-band-facts",
      "cb-detail-band-content",
    ]);
    // the tab component is not drawn at all
    expect(container.querySelector(".cb-tabs")).toBeNull();
  });
});

describe("the band form on a phone (spec §4.2)", () => {
  it("puts the path on its own line and the actions under it", () => {
    const narrow = shell.slice(shell.indexOf("@media (max-width: 639px)"));
    expect(narrow).toMatch(/\.cb-pageheader-titleless\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(narrow).toMatch(
      /\.cb-pageheader-titleless\s+\.cb-pageheader-path\s*\{[^}]*flex:\s*1 1 100%/,
    );
  });
});
