import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge, DesignProvider, DeviceNameplate } from "../src/index";

afterEach(cleanup);
const display = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
const ruleOf = (selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
    display,
  )?.[1] ?? "";

const LAST_SEEN = "2026-11-13T08:21:00Z";

function plate(over: Partial<Parameters<typeof DeviceNameplate>[0]> = {}) {
  return render(
    <DesignProvider locale="zh">
      <DeviceNameplate
        name="设计工作机"
        origin="local"
        state="online"
        version="0.4.0"
        lastSeen={LAST_SEEN}
        {...over}
      />
    </DesignProvider>,
  );
}

describe("DeviceNameplate", () => {
  it("draws the name, origin, status light and mono figures in the design's words", () => {
    const { container } = plate();
    expect(screen.getByText("设计工作机")).toBeTruthy();
    expect(screen.getByText("本地设备")).toBeTruthy();
    expect(screen.getByText("在线")).toBeTruthy();
    expect(screen.getByText("程序")).toBeTruthy();
    expect(screen.getByText("最后活跃")).toBeTruthy();
    // versions always carry the leading v (spec §2.2)
    expect(screen.getByText("v0.4.0")).toBeTruthy();
    const time = container.querySelector('[data-part="device-nameplate-value"] time');
    expect(time?.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const light = container.querySelector('[data-part="device-nameplate-light"]') as HTMLElement;
    expect(light.dataset.state).toBe("online");
  });

  it("draws the cloud running state with an optional mode badge", () => {
    plate({ origin: "cloud", state: "running", badge: <Badge tone="warn">自动</Badge> });
    expect(screen.getByText("云端设备")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("自动")).toBeTruthy();
  });

  it("draws a dash for a missing version and 从未连接 without a last seen time", () => {
    plate({ version: null, lastSeen: null });
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("从未连接")).toBeTruthy();
  });

  it("takes the page's own labels", () => {
    plate({
      state: "suspended",
      labels: { state: { suspended: "已挂起" }, lastSeen: "上次在线", version: "版本" },
    });
    expect(screen.getByText("已挂起")).toBeTruthy();
    expect(screen.getByText("上次在线")).toBeTruthy();
    expect(screen.getByText("版本")).toBeTruthy();
  });

  it("colors the status light from tokens: accent running, ok online, warn suspended, muted offline", () => {
    expect(ruleOf('.cb-nameplate-light[data-state="running"]')).toMatch(
      /background:\s*var\(--cb-accent\)/,
    );
    expect(ruleOf('.cb-nameplate-light[data-state="online"]')).toMatch(
      /background:\s*var\(--cb-ok\)/,
    );
    expect(ruleOf('.cb-nameplate-light[data-state="suspended"]')).toMatch(
      /background:\s*var\(--cb-warn\)/,
    );
    expect(ruleOf('.cb-nameplate-light[data-state="offline"]')).toMatch(
      /background:\s*var\(--cb-muted\)/,
    );
    expect(ruleOf(".cb-nameplate")).toMatch(/background:\s*var\(--cb-panel\)/);
    expect(ruleOf(".cb-nameplate-figures")).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(ruleOf(".cb-nameplate-name")).toMatch(/text-overflow:\s*ellipsis/);
  });
});
