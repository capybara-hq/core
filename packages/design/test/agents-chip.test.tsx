import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsChip, ComposerBox, DesignProvider, QuickActions } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const chip = () => document.querySelector('[data-part="agents-chip"]') as HTMLElement | null;
const dot = () => chip()?.querySelector('[data-part="agent-dot"]') ?? null;

describe("AgentsChip (§6.16.29, acceptance item AC3)", () => {
  it("is nothing without sub-agents", () => {
    wrap(<AgentsChip count={0} running={0} onOpen={() => {}} />);
    expect(chip()).toBeNull();
  });

  it("names the total; the accessible name and tooltip add the running count", () => {
    wrap(<AgentsChip count={3} running={1} onOpen={() => {}} />);
    const c = chip() as HTMLElement;
    expect(c.textContent).toBe("3 个智能体");
    expect(c.getAttribute("aria-label")).toBe("3 个智能体，1 个运行中");
    expect(c.getAttribute("title")).toBe("3 个智能体，1 个运行中");
    expect(c.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.getByRole("button", { name: "3 个智能体，1 个运行中" })).toBe(c);
    cleanup();
    wrap(<AgentsChip count={1} running={0} onOpen={() => {}} />, "en");
    expect(chip()?.textContent).toBe("1 agent");
    expect(chip()?.getAttribute("aria-label")).toBe("1 agent, 0 running");
    cleanup();
    wrap(<AgentsChip count={4} running={0} waiting={2} onOpen={() => {}} />, "en");
    expect(chip()?.textContent).toBe("4 agents");
    expect(chip()?.getAttribute("aria-label")).toBe("4 agents, 0 running, 2 waiting");
  });

  it("the status dot is the agent map's: accent pulse while one runs, warn while one waits, none when settled", () => {
    const { rerender } = wrap(<AgentsChip count={3} running={1} waiting={1} onOpen={() => {}} />);
    expect(dot()?.getAttribute("data-status")).toBe("running");
    // the map's pulsing dot (role img: agent-map.css animates only that)
    expect(dot()?.getAttribute("role")).toBe("img");
    expect(dot()?.classList.contains("cb-amap-dot")).toBe(true);
    // the dot leads the label
    expect(chip()?.querySelector(".cb-btn-body")?.firstElementChild).toBe(dot());
    rerender(
      <DesignProvider locale="zh">
        <AgentsChip count={3} running={0} waiting={1} onOpen={() => {}} />
      </DesignProvider>,
    );
    expect(dot()?.getAttribute("data-status")).toBe("waiting");
    rerender(
      <DesignProvider locale="zh">
        <AgentsChip count={3} running={0} onOpen={() => {}} />
      </DesignProvider>,
    );
    expect(dot()).toBeNull();
  });

  it("opens on click and from the keyboard", async () => {
    const onOpen = vi.fn();
    wrap(<AgentsChip count={2} running={0} onOpen={onOpen} />);
    await userEvent.click(chip() as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
    (chip() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("is a picker-styled ghost button with the dot spaced from the label", () => {
    wrap(<AgentsChip count={2} running={1} onOpen={() => {}} />);
    const c = chip() as HTMLElement;
    expect(c.dataset.variant).toBe("ghost");
    expect(c.classList.contains("cb-picker")).toBe(true);
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
      "utf8",
    );
    expect(css).toMatch(/\.cb-agents-chip\.cb-btn \.cb-btn-body \{\s*gap: var\(--cb-space-2\);/);
  });

  it("sits in the composer's control row after the effort picker and the quick actions", () => {
    const picker = (label: string, value: string) => ({
      label,
      value,
      groups: [{ items: [{ id: value, label: value, checked: true }] }],
      onPick: () => {},
    });
    wrap(
      <ComposerBox
        value=""
        onChange={() => {}}
        placeholder="输入消息"
        onAttach={() => {}}
        pickers={{ model: picker("切换模型", "fake-1"), effort: picker("思考档位", "中") }}
        quickActions={<QuickActions items={[{ id: "q", title: "周报" }]} onPick={() => {}} />}
        agents={<AgentsChip count={2} running={0} onOpen={() => {}} />}
        send={{ mode: "send", onClick: () => {} }}
      />,
    );
    const bar = document.querySelector('[data-part="composer-bar"]') as HTMLElement;
    const parts = Array.from(bar.children).map(
      (el) => el.getAttribute("data-part") ?? el.className,
    );
    const at = parts.indexOf("agents-chip");
    expect(at).toBe(parts.indexOf("quick-actions") + 1);
    expect(parts.indexOf("quick-actions")).toBeGreaterThan(parts.lastIndexOf("picker"));
    expect(parts[at + 1]).toBe("cb-grow");
    expect(within(bar).getByRole("button", { name: "2 个智能体，0 个运行中" })).toBeTruthy();
  });
});
