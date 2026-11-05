import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, RunDivider, ToolGroup, ToolRow, type ToolRowData } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const bash = (over: Partial<ToolRowData> = {}): ToolRowData => ({
  id: "b1",
  kind: "command",
  name: "Bash",
  description: "Start the dev server",
  extra: "In background",
  status: "done",
  detail: { command: "pnpm dev", output: "Started background task bt_abc234." },
  ...over,
});

describe("the tool row's link (§6.16.9)", () => {
  it("a row draws its link inside the row, beside the toggle, never nested in it", async () => {
    const onOpen = vi.fn();
    const { container } = wrap(
      <ToolRow row={bash({ link: { label: "View output of Start the dev server", onOpen } })} />,
    );
    const row = container.querySelector('[data-part="tool-row"]') as HTMLElement;
    expect(row.getAttribute("data-linked")).toBe("true");
    const link = row.querySelector('[data-part="tool-link"]') as HTMLElement;
    expect(link.textContent).toBe("View output of Start the dev server");
    expect(link.closest("button[aria-expanded]")).toBeNull();
    const toggle = row.querySelector("button[aria-expanded]") as HTMLElement;
    expect(toggle.contains(link)).toBe(false);
    const user = userEvent.setup();
    await user.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // the link does not toggle the detail; the toggle still does
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-part="tool-detail"]')).toBeTruthy();
  });

  it("a single call's line draws the link beside its toggle", async () => {
    const onOpen = vi.fn();
    const { container } = wrap(
      <ToolGroup rows={[bash({ link: { label: "View output", onOpen } })]} />,
    );
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    expect(line.getAttribute("data-linked")).toBe("true");
    await userEvent.setup().click(screen.getByRole("button", { name: "View output" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(line.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("a row without detail and with a link: the label and the link", () => {
    const { detail: _, ...plain } = bash();
    const { container } = wrap(
      <ToolRow row={{ ...plain, link: { label: "View output", onOpen: vi.fn() } }} />,
    );
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(screen.getByRole("button", { name: "View output" })).toBeTruthy();
  });

  it("a row without a link is unchanged: the row itself is the toggle", () => {
    const { container } = wrap(<ToolRow row={bash()} />);
    const row = container.querySelector('[data-part="tool-row"]') as HTMLElement;
    expect(row.tagName).toBe("BUTTON");
    expect(container.querySelector('[data-part="tool-link"]')).toBeNull();
  });
});

describe("the notice divider (§6.16.7)", () => {
  it("is muted, a status, and its action defaults to Open", async () => {
    const onClick = vi.fn();
    const { container } = wrap(
      <RunDivider
        kind="notice"
        text="Background task “x” failed · exit code 1"
        action={{ onClick }}
      />,
    );
    const d = container.querySelector('[data-part="run-divider"]') as HTMLElement;
    expect(d.getAttribute("data-kind")).toBe("notice");
    expect(d.getAttribute("data-tone")).toBeNull();
    expect(d.getAttribute("role")).toBe("status");
    await userEvent.setup().click(screen.getByRole("button", { name: "Open" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("zh: 打开", () => {
    wrap(<RunDivider kind="notice" text="后台任务" action={{ onClick: vi.fn() }} />, "zh");
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
  });
});
