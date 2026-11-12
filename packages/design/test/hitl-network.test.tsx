import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBlock,
  type ApprovalBlockProps,
  clipCommand,
  DesignProvider,
  NetworkBlockedFacts,
  registrableDomain,
} from "../src/index";
import { findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const ask = (over: Partial<ApprovalBlockProps> = {}): ApprovalBlockProps => ({
  tool: "Bash",
  toolKey: "Bash",
  input: {},
  scopes: ["once", "always"],
  network: {
    hosts: ["files.slack.com"],
    command: "curl -sS https://files.slack.com/x",
    description: "Download the export",
  },
  state: { kind: "pending" },
  onApprove: () => {},
  onDeny: () => {},
  ...over,
});

const many = { hosts: ["files.slack.com", "api.github.com"], command: "npm install" };

describe("registrableDomain (a display aid)", () => {
  it.each([
    ["files.slack.com", "slack.com"],
    ["files.slack.com.evil.io", "evil.io"],
    ["slack.com", "slack.com"],
    ["a.b.example.co.uk", "example.co.uk"],
    ["mirrors.aliyun.com.cn", "aliyun.com.cn"],
    ["Files.Slack.COM.", "slack.com"],
    ["10.0.0.5", "10.0.0.5"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"],
  ])("%s → %s", (host, want) => {
    expect(registrableDomain(host)).toBe(want);
  });
});

describe("clipCommand", () => {
  it("keeps a short command and clips a long one to 300 characters", () => {
    expect(clipCommand("ls")).toBe("ls");
    const long = "x".repeat(400);
    const clipped = clipCommand(long);
    expect(Array.from(clipped)).toHaveLength(300);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("ApprovalBlock, network variant (network ask spec §6.5)", () => {
  it("one host: the title names it, the body the description, the command in code, the registrable domain prominent", () => {
    const { container } = wrap(<ApprovalBlock {...ask()} />);
    const group = screen.getByRole("group", { name: "智能体想访问 files.slack.com，允许吗？" });
    expect(group.getAttribute("data-pending")).toBe("true");
    expect(container.querySelector('[data-part="network-title"] code')?.textContent).toBe(
      "files.slack.com",
    );
    expect(
      screen.getByText("这条命令被这台设备的网络规则拦下了：Download the export"),
    ).toBeTruthy();
    expect(container.querySelector('[data-part="network-command"]')?.textContent).toBe(
      "curl -sS https://files.slack.com/x",
    );
    expect(container.querySelector('[data-part="registrable"]')?.textContent).toBe("slack.com");
    // no checkboxes for one host, no tool key, no argument grid
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelector('[data-part="kv"]')).toBeNull();
    expect(screen.queryByText("需要你批准")).toBeNull();
  });

  it("the primary button is 这次允许, never 一直允许; each has its hint", () => {
    wrap(<ApprovalBlock {...ask()} />);
    const once = screen.getByRole("button", { name: "这次允许" });
    const always = screen.getByRole("button", { name: "这台设备一直允许" });
    expect(once.getAttribute("data-variant")).toBe("primary");
    expect(always.getAttribute("data-variant")).toBe("default");
    expect(screen.getByText("到智能体这次回复结束为止有效")).toBeTruthy();
    const hints = [...document.querySelectorAll('[data-part="scope-hint"]')].map(
      (h) => h.textContent,
    );
    expect(hints[1]).toBe(
      "写入这台设备的本地策略，之后的命令都可以访问；可在设备页或用 capybara-device policy 撤销",
    );
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(document.querySelector('[data-part="network-remote-off"]')).toBeNull();
  });

  it("approving passes the scope and the host", async () => {
    const onApprove = vi.fn();
    wrap(<ApprovalBlock {...ask({ onApprove })} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "这台设备一直允许" }));
    expect(onApprove).toHaveBeenCalledWith("always", ["files.slack.com"]);
  });

  it("n hosts: a checkbox per host, all checked; the decision carries the checked ones; none checked disables approving", async () => {
    const onApprove = vi.fn();
    wrap(<ApprovalBlock {...ask({ network: many, onApprove })} />);
    expect(screen.getByRole("group", { name: "智能体想访问 2 个域名，允许吗？" })).toBeTruthy();
    expect(screen.getByText("这条命令被这台设备的网络规则拦下了。")).toBeTruthy();
    const boxes = within(screen.getByRole("group", { name: "域名" })).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "api.github.com" }));
    await user.click(screen.getByRole("button", { name: "这次允许" }));
    expect(onApprove).toHaveBeenCalledWith("once", ["files.slack.com"]);
    await user.click(screen.getByRole("checkbox", { name: "files.slack.com" }));
    expect((screen.getByRole("button", { name: "这次允许" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "这台设备一直允许" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Deny stays available
    expect((screen.getByRole("button", { name: "拒绝" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("only once offered (remote grants off): no 一直允许, and the device command hint", () => {
    const { container } = wrap(<ApprovalBlock {...ask({ scopes: ["once"] })} />);
    expect(screen.queryByRole("button", { name: "这台设备一直允许" })).toBeNull();
    expect(container.querySelector('[data-part="network-remote-off"]')?.textContent).toBe(
      "这台设备不接受远程修改；要一直允许，请在设备上运行 capybara-device policy add allowedDomains files.slack.com",
    );
  });

  it("Deny asks for an optional reason, as for tool approvals", async () => {
    const onDeny = vi.fn();
    wrap(<ApprovalBlock {...ask({ onDeny })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    await user.type(screen.getByRole("textbox", { name: "拒绝原因" }), "不需要");
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onDeny).toHaveBeenCalledWith("不需要");
  });

  it("long commands are clipped and model text is never markup", () => {
    const command = `<b>bold</b>${"a".repeat(400)}`;
    const { container } = wrap(
      <ApprovalBlock {...ask({ network: { hosts: ["x.`y`.com"], command } })} />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector('[data-part="network-command"]')?.textContent).toHaveLength(300);
  });

  it.each([
    [{ decision: "approved", scope: "once" }, "已允许（这次）"],
    [{ decision: "approved", scope: "always" }, "已允许（这台设备）"],
    [{ decision: "denied" }, "已拒绝"],
    [{ decision: "expired" }, "已过期"],
    [{ decision: "skipped" }, "已跳过"],
  ] as const)("decided %o reads %s", (d, word) => {
    const { container } = wrap(
      <ApprovalBlock {...ask({ state: { kind: "decided", who: "张三", when: "10:41", ...d } })} />,
    );
    const line = container.querySelector('[data-part="tool-line"]');
    expect(line?.getAttribute("data-decision")).toBe(d.decision);
    expect(line?.textContent?.startsWith(word)).toBe(true);
    expect(line?.textContent).toContain("files.slack.com");
    if (d.decision === "expired") expect(line?.textContent).not.toContain("张三");
    else expect(line?.textContent).toContain("张三");
  });

  it("decided: the granted hosts, the fallback note and the reason", () => {
    const { container, rerender } = wrap(
      <ApprovalBlock
        {...ask({
          network: many,
          state: {
            kind: "decided",
            decision: "approved",
            scope: "once",
            who: "张三",
            when: "10:41",
            hosts: ["api.github.com"],
            fallback: "offline",
          },
        })}
      />,
    );
    const line = container.querySelector('[data-part="tool-line"]');
    expect(line?.textContent).toContain("api.github.com");
    expect(line?.textContent).not.toContain("files.slack.com");
    expect(container.querySelector('[data-part="network-fallback"]')?.textContent).toBe(
      " · 设备离线，已按这次允许",
    );
    rerender(
      <DesignProvider locale="en">
        <ApprovalBlock
          {...ask({
            state: {
              kind: "decided",
              decision: "approved",
              scope: "once",
              who: "Ann",
              when: "10:41",
              fallback: "refused",
            },
          })}
        />
      </DesignProvider>,
    );
    expect(container.textContent).toContain("Allowed (this time)");
    expect(container.textContent).toContain(
      "The device does not accept remote changes; allowed this time instead",
    );
    rerender(
      <DesignProvider locale="en">
        <ApprovalBlock
          {...ask({
            state: { kind: "decided", decision: "denied", who: "Ann", when: "", reason: "no" },
          })}
        />
      </DesignProvider>,
    );
    expect(container.textContent).toContain("Denied files.slack.com · Ann · “no”");
  });

  it("speaks English", () => {
    wrap(<ApprovalBlock {...ask({ network: many })} />, "en");
    expect(
      screen.getByRole("group", { name: "The agent wants to reach 2 domains. Allow?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow this time" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow on this device" })).toBeTruthy();
    expect(screen.getByText("Until the agent finishes this reply")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("a tool approval may be skipped too", () => {
    const { container } = wrap(
      <ApprovalBlock
        tool="Acme"
        toolKey="acme__x"
        input={{}}
        scopes={["once"]}
        state={{ kind: "decided", decision: "skipped", who: "张三", when: "10:41" }}
      />,
    );
    expect(container.textContent).toContain("批准请求已跳过：Acme");
  });
});

describe("NetworkBlockedFacts", () => {
  it("states the org and address layers as text, no box inside a box, nothing for none", () => {
    const { container, rerender } = wrap(
      <NetworkBlockedFacts
        hosts={[
          { host: "api.foo.com", layer: "org" },
          { host: "10.0.0.5", layer: "address" },
        ]}
      />,
    );
    const facts = [...container.querySelectorAll('[data-part="network-fact"]')];
    expect(facts.map((f) => f.textContent)).toEqual([
      "api.foo.com 不在组织的网络白名单里，只有组织管理员能添加。",
      "10.0.0.5：这个地址指向内网或本机，智能体的命令不能访问。",
    ]);
    expect(facts[0]?.querySelector("code")?.textContent).toBe("api.foo.com");
    expect(screen.queryByRole("button")).toBeNull();
    expect(findNestedBoxes(container)).toEqual([]);
    rerender(
      <DesignProvider locale="zh">
        <NetworkBlockedFacts hosts={[]} />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-part="network-facts"]')).toBeNull();
  });

  it("the org-layer action slot", async () => {
    const onSelect = vi.fn();
    wrap(
      <NetworkBlockedFacts
        hosts={[{ host: "api.foo.com", layer: "org" }]}
        action={{ label: "请管理员添加", onSelect }}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "请管理员添加" }));
    expect(onSelect).toHaveBeenCalled();
  });
});
