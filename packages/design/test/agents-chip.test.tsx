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
const label = () => chip()?.querySelector('[data-part="agents-chip-label"]')?.textContent;

describe("AgentsChip (§6.16.29, acceptance item AC3)", () => {
  it("is nothing without sub-agents", () => {
    wrap(<AgentsChip count={0} running={0} onOpen={() => {}} />);
    expect(chip()).toBeNull();
  });

  it("names the total; the accessible name and tooltip add the running count", () => {
    wrap(<AgentsChip count={3} running={1} onOpen={() => {}} />);
    const c = chip() as HTMLElement;
    expect(label()).toBe("3 个智能体");
    expect(c.getAttribute("aria-label")).toBe("3 个智能体，1 个运行中");
    expect(c.getAttribute("title")).toBe("3 个智能体，1 个运行中");
    expect(c.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.getByRole("button", { name: "3 个智能体，1 个运行中" })).toBe(c);
    cleanup();
    wrap(<AgentsChip count={1} running={0} onOpen={() => {}} />, "en");
    expect(label()).toBe("1 agent");
    expect(chip()?.getAttribute("aria-label")).toBe("1 agent, 0 running");
    cleanup();
    wrap(<AgentsChip count={4} running={0} waiting={2} onOpen={() => {}} />, "en");
    expect(label()).toBe("4 agents");
    expect(chip()?.getAttribute("aria-label")).toBe("4 agents, 0 running, 2 waiting");
  });

  it("the status dot is the agent map's: accent pulse while one runs, warn while one waits, faint when settled", () => {
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
    // settled: the plain dot (no status: the map's `faint` ground), decorative, still leading
    expect(dot()?.hasAttribute("data-status")).toBe(false);
    expect(dot()?.classList.contains("cb-amap-dot")).toBe(true);
    expect(dot()?.getAttribute("aria-hidden")).toBe("true");
    expect(chip()?.querySelector(".cb-btn-body")?.firstElementChild).toBe(dot());
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/agent-map.css"), "utf8");
    expect(css).toMatch(/\.cb-amap-dot \{[^}]*background: var\(--cb-faint\);/);
  });

  it("below 600 it is the dot and the count; the full text stays its name", () => {
    wrap(<AgentsChip count={3} running={0} onOpen={() => {}} />);
    const count = chip()?.querySelector('[data-part="agents-chip-count"]') as HTMLElement;
    expect(count.textContent).toBe("3");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(dot()).not.toBeNull();
    expect(chip()?.getAttribute("aria-label")).toBe("3 个智能体，0 个运行中");
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
      "utf8",
    );
    const phone = css.slice(
      css.indexOf("@media not all and (min-width: 600px) {\n  .cb-agents-chip-label"),
    );
    expect(phone).toMatch(/\.cb-agents-chip-label \{\s*display: none;/);
    expect(phone).toMatch(/\.cb-agents-chip-count \{\s*display: inline;/);
    // wide: the count alone is hidden
    expect(css).toMatch(/\n\.cb-agents-chip-count \{\s*display: none;/);
    // the pickers' labels give way with an ellipsis; the icon buttons and the chip keep their size
    expect(css).toMatch(/\.cb-picker-value \{\s*overflow: hidden;\s*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.cb-composer-bar > \.cb-icon-btn \{\s*flex: none;/);
    expect(css).toMatch(/\.cb-agents-chip\.cb-btn \{\s*flex: none;/);
  });

  it("the label is the count alone, its number emphasized; no activity text in any state", () => {
    const { rerender } = wrap(<AgentsChip count={27} running={0} onOpen={() => {}} />);
    const body = () => chip()?.querySelector(".cb-btn-body") as HTMLElement;
    const visibleText = () =>
      Array.from(body().children)
        .filter((el) => el.getAttribute("data-part") !== "agents-chip-count")
        .map((el) => el.textContent)
        .join("");
    expect(visibleText()).toBe("27 个智能体");
    const number = chip()?.querySelector('[data-part="agents-chip-number"]') as HTMLElement;
    expect(number.textContent).toBe("27");
    expect(number.closest('[data-part="agents-chip-label"]')).not.toBeNull();
    rerender(
      <DesignProvider locale="zh">
        <AgentsChip count={27} running={3} waiting={1} onOpen={() => {}} />
      </DesignProvider>,
    );
    expect(visibleText()).toBe("27 个智能体");
    expect(chip()?.getAttribute("aria-label")).toBe("27 个智能体，3 个运行中，1 个等待中");
    rerender(
      <DesignProvider locale="en">
        <AgentsChip count={27} running={0} waiting={2} onOpen={() => {}} />
      </DesignProvider>,
    );
    expect(visibleText()).toBe("27 agents");
    expect(chip()?.getAttribute("aria-label")).toBe("27 agents, 0 running, 2 waiting");
    const css = readFileSync(
      resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.cb-agents-chip-number \{\s*color: var\(--cb-ink\);\s*font-weight: 500;\s*font-variant-numeric: tabular-nums;/,
    );
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
