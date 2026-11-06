import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAP_FIXTURE } from "../src/fixtures/index";
import {
  type AgentMapBackground,
  AgentMapDialog,
  type AgentMapNode,
  AgentMapTree,
  agentMapTokens,
  DesignProvider,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const F = AGENT_MAP_FIXTURE;
const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const background: AgentMapBackground[] = F.background.map((b) => ({
  kind: "task",
  id: b.id,
  description: b.description,
  status: b.status,
  startedAt: NOW - b.durationMs,
  ...(b.status === "running" ? {} : { finishedAt: NOW }),
}));
const root: AgentMapNode = F.root;
const nodes = () => screen.getAllByRole("button").filter((b) => b.dataset.part === "agent-node");
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/agent-map.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", at), css.indexOf("}", at));
};

describe("AgentMapTree (§6.16.28)", () => {
  it('every node has the same height and one meta line "model · time · tokens"', () => {
    wrap(<AgentMapTree root={root} background={[]} onOpen={() => {}} now={NOW} />);
    const all = nodes();
    expect(all).toHaveLength(6);
    for (const n of all) {
      const metas = n.querySelectorAll('[data-part="agent-node-meta"]');
      expect(metas).toHaveLength(1);
      expect(metas[0]?.textContent).toMatch(/^\w+ 5\.5 · (\d+分)?\d+ ?秒 · [\d.]+k tokens$/);
    }
    expect(
      within(all[0] as HTMLElement).getByText("opus 5.5 · 42分18秒 · 392.7k tokens"),
    ).toBeTruthy();
    // Equal height: one fixed height for every node, and both lines one line with an ellipsis.
    expect(rule(".cb-amap-node")).toMatch(/height: 62px;/);
    for (const line of [".cb-amap-node-name", ".cb-amap-node-meta"]) {
      expect(rule(line)).toMatch(/white-space: nowrap;/);
      expect(rule(line)).toMatch(/text-overflow: ellipsis;/);
    }
    // The full text on hover.
    expect(all[0]?.getAttribute("title")).toBe(
      "整理季度经营报告\nopus 5.5 · 42分18秒 · 392.7k tokens",
    );
  });

  it("status is a dot with an accessible label, no status word", () => {
    wrap(<AgentMapTree root={root} background={[]} onOpen={() => {}} now={NOW} />);
    const words = ["运行中", "等待", "完成", "失败", "已停止"];
    for (const n of nodes()) {
      const dot = n.querySelector('[data-part="agent-dot"]');
      expect(dot?.getAttribute("role")).toBe("img");
      expect(words).toContain(dot?.getAttribute("aria-label"));
      const visible = (n.textContent ?? "").trim();
      for (const w of words) expect(visible).not.toContain(w);
    }
    const waiting = nodes().find((n) => n.textContent?.includes("起草管理层摘要"));
    expect(waiting?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "waiting",
    );
    // The legend names every colour once.
    const legend = screen.getByRole("list", { name: "图例" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(words);
  });

  it('the header counts agents and running ones ("6 个智能体 · 2 个运行中")', () => {
    // Three of the six run in the fixture; drop the review to match the mockup's count.
    const two: AgentMapNode = {
      ...root,
      children: root.children.map((c) =>
        c.id === "am_invoice"
          ? { ...c, children: c.children.map((g) => ({ ...g, status: "completed" as const })) }
          : c,
      ),
    };
    wrap(<AgentMapTree root={two} background={[]} onOpen={() => {}} now={NOW} />);
    expect(screen.getByText("6 个智能体 · 2 个运行中 · 点击查看详情")).toBeTruthy();
    cleanup();
    wrap(<AgentMapTree root={two} background={[]} onOpen={() => {}} now={NOW} />, "en");
    expect(screen.getByText("6 agents · 2 running · Click a node for details")).toBeTruthy();
  });

  it("background tasks render under the root column", () => {
    wrap(<AgentMapTree root={root} background={background} onOpen={() => {}} now={NOW} />);
    const section = screen.getByRole("region", { name: "后台任务 · 2" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe("Bash启动本地预览服务8分02秒");
    expect(rows[0]?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "running",
    );
    expect(rows[1]?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "completed",
    );
    // Under the tree, as wide as a node (the root column), not inside the branches.
    expect(section.closest('[data-part="agent-branch"]')).toBeNull();
    expect(rule(".cb-amap-background")).toMatch(/width: 320px;/);
    cleanup();
    wrap(<AgentMapTree root={root} background={[]} onOpen={() => {}} now={NOW} />);
    expect(screen.queryByRole("region", { name: /后台任务/ })).toBeNull();
  });

  it("a node is a button that calls onOpen with its id", async () => {
    const onOpen = vi.fn();
    wrap(
      <AgentMapTree
        root={root}
        background={[]}
        selectedId={F.selected}
        onOpen={onOpen}
        now={NOW}
      />,
    );
    const review = nodes().find((n) => n.textContent?.includes("复查发票核对结果"));
    await userEvent.click(review as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith("am_review");
    const selected = nodes().filter((n) => n.getAttribute("aria-current") === "true");
    expect(selected.map((n) => n.dataset.id)).toEqual(["am_invoice"]);
    (nodes()[0] as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("am_root");
  });

  it("three levels below the root lay out in four columns", () => {
    wrap(<AgentMapTree root={F.deep} background={[]} onOpen={() => {}} now={NOW} />);
    const canvas = document.querySelector('[data-part="agent-map"]');
    expect(canvas?.getAttribute("data-columns")).toBe("4");
    const depth = (text: string) =>
      nodes()
        .find((n) => n.textContent?.includes(text))
        ?.getAttribute("data-depth");
    expect(depth("整理季度经营报告")).toBe("0");
    expect(depth("核对供应商发票与付款记录")).toBe("1");
    expect(depth("汇总各区域销售数据")).toBe("1");
    expect(depth("复查发票核对结果")).toBe("2");
    expect(depth("抽查十张大额发票")).toBe("3");
    // A branch is a node followed by its children's column.
    const branch = nodes()[1]?.closest('[data-part="agent-branch"]');
    expect(branch?.querySelector(':scope > [data-part="agent-kids"]')).toBeTruthy();
  });

  it("formats tokens as the mockup does", () => {
    expect(agentMapTokens(392_700, "zh")).toBe("392.7k tokens");
    expect(agentMapTokens(950, "en")).toBe("950 tokens");
    expect(agentMapTokens(1_250_000, "zh")).toBe("1.3M tokens");
  });
});

describe("AgentMapDialog (§6.16.28)", () => {
  it("is as wide as its level and closes from its close button", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = wrap(
      <AgentMapDialog open onOpenChange={onOpenChange} level="tree">
        <p>body</p>
      </AgentMapDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "智能体图" });
    expect(dialog.getAttribute("data-size")).toBe("1100");
    for (const [level, size] of [
      ["detail", "760"],
      ["transcript", "1060"],
    ] as const) {
      rerender(
        <DesignProvider locale="zh">
          <AgentMapDialog open onOpenChange={onOpenChange} level={level}>
            <p>body</p>
          </AgentMapDialog>
        </DesignProvider>,
      );
      expect(screen.getByRole("dialog").getAttribute("data-size")).toBe(size);
    }
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the dialog sizes include the agent map widths", () => {
    const overlays = readFileSync(
      resolve(import.meta.dirname, "../src/styles/overlays.css"),
      "utf8",
    );
    for (const w of [760, 1060, 1100]) {
      expect(overlays).toContain(`.cb-dialog[data-size="${w}"]`);
      expect(overlays).toContain(`width: min(${w}px, calc(100vw - 32px));`);
    }
  });
});
