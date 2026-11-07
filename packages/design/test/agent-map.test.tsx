import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAP_FIXTURE } from "../src/fixtures/index";
import {
  AgentCallBlock,
  type AgentCallState,
  AgentDetail,
  type AgentMapBackground,
  AgentMapDialog,
  type AgentMapNode,
  AgentMapTree,
  type AgentToolCallRow,
  agentMapTokens,
  Card,
  CodeBlock,
  DesignProvider,
  SkeletonBars,
  TranscriptFrame,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

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
const nodes = () => [...document.querySelectorAll<HTMLElement>('[data-part="agent-node"]')];
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

  it('the header counts the sub-agents and running ones, the root not counted ("5 个智能体 · 1 个运行中")', () => {
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
    expect(screen.getByText("5 个智能体 · 1 个运行中 · 点击查看详情")).toBeTruthy();
    cleanup();
    wrap(<AgentMapTree root={two} background={[]} onOpen={() => {}} now={NOW} />, "en");
    expect(screen.getByText("5 agents · 1 running · Click a node for details")).toBeTruthy();
    cleanup();
    // one sub-agent: the chip's singular
    const one: AgentMapNode = { ...root, children: [{ ...(root.children[0] as AgentMapNode) }] };
    wrap(<AgentMapTree root={one} background={[]} onOpen={() => {}} now={NOW} />, "en");
    expect(screen.getByText("1 agent · 0 running · Click a node for details")).toBeTruthy();
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
    const invoiceNode = nodes().find((n) => n.dataset.id === "am_invoice") as HTMLElement;
    invoiceNode.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("am_invoice");
  });

  it("the root opens nothing and is never the selected node", async () => {
    const onOpen = vi.fn();
    wrap(
      <AgentMapTree root={root} background={[]} selectedId="am_root" onOpen={onOpen} now={NOW} />,
    );
    const rootNode = nodes().find((n) => n.dataset.root === "true") as HTMLElement;
    expect(rootNode.tagName).not.toBe("BUTTON");
    expect(rootNode.getAttribute("aria-current")).toBeNull();
    await userEvent.click(rootNode);
    expect(onOpen).not.toHaveBeenCalled();
    // the other nodes stay buttons
    expect(nodes().filter((n) => n.tagName === "BUTTON")).toHaveLength(5);
    expect(rule('.cb-amap-node[data-root="true"]')).toMatch(/cursor: default;/);
  });

  it("the tree canvas is a labelled, keyboard-focusable scroll region", () => {
    wrap(<AgentMapTree root={F.deep} background={[]} onOpen={() => {}} now={NOW} />);
    const canvas = screen.getByRole("region", { name: "智能体树" });
    expect(canvas.dataset.part).toBe("agent-map");
    expect(canvas.getAttribute("tabindex")).toBe("0");
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
      ["detail", "chat"],
      ["transcript", "chat"],
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
    // Levels 2 and 3 bring their own head (back, title, close): the frame draws none.
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    rerender(
      <DesignProvider locale="zh">
        <AgentMapDialog open onOpenChange={onOpenChange} level="tree">
          <p>body</p>
        </AgentMapDialog>
      </DesignProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the tree level pads what a page shows while it reads the tree (loading bars, an error)", () => {
    wrap(
      <AgentMapDialog open onOpenChange={() => {}} level="tree">
        <SkeletonBars />
      </AgentMapDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "智能体图" });
    const content = dialog.querySelector('[data-part="agent-map-content"]') as HTMLElement;
    expect(content.querySelector(".cb-skeleton-list")).not.toBeNull();
    // the head stays outside the padded body
    expect(content.querySelector('[data-part="agent-map-head"]')).toBeNull();
  });

  it("the inline frame and the portal frame draw the same head", () => {
    wrap(
      <AgentMapDialog open inline onOpenChange={() => {}} level="tree">
        <p>body</p>
      </AgentMapDialog>,
    );
    const inline = screen.getByRole("dialog");
    const inlineHead = inline.querySelector('[data-part="agent-map-head"]')?.outerHTML;
    expect(inlineHead).toContain("智能体图");
    cleanup();
    wrap(
      <AgentMapDialog open onOpenChange={() => {}} level="tree">
        <p>body</p>
      </AgentMapDialog>,
    );
    const portal = screen.getByRole("dialog");
    const strip = (h: string | undefined) => h?.replace(/ id="[^"]*"/g, "");
    expect(strip(portal.querySelector('[data-part="agent-map-head"]')?.outerHTML)).toBe(
      strip(inlineHead),
    );
  });

  it("Esc at levels 2 and 3 goes back one level; at the tree it closes", async () => {
    const onOpenChange = vi.fn();
    const onBack = vi.fn();
    const { rerender } = wrap(
      <AgentMapDialog open onOpenChange={onOpenChange} level="detail" onBack={onBack}>
        <p>body</p>
      </AgentMapDialog>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    rerender(
      <DesignProvider locale="zh">
        <AgentMapDialog open onOpenChange={onOpenChange} level="tree">
          <p>body</p>
        </AgentMapDialog>
      </DesignProvider>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moving to another level (or agent) puts focus on its back button, or the tree's title", () => {
    const detail = (id: string) => (
      <DesignProvider locale="zh">
        <AgentMapDialog open onOpenChange={() => {}} level="detail" view={`detail:${id}`}>
          <AgentDetail
            node={{ ...invoice, id }}
            agentType="general-purpose"
            inBackground
            spawnedBy={{ id: "am_root", label: "整理季度经营报告" }}
            latestText=""
            task=""
            background={[]}
            toolCalls={[]}
            onBack={() => {}}
            onClose={() => {}}
            onOpenParent={() => {}}
            onOpenTranscript={() => {}}
          />
        </AgentMapDialog>
      </DesignProvider>
    );
    const { rerender } = wrap(
      <AgentMapDialog open onOpenChange={() => {}} level="tree" view="tree">
        <AgentMapTree root={root} background={[]} onOpen={() => {}} now={NOW} />
      </AgentMapDialog>,
    );
    rerender(detail("am_invoice"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回智能体图");
    (document.body as HTMLElement).focus();
    rerender(detail("am_review"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回智能体图");
    rerender(
      <DesignProvider locale="zh">
        <AgentMapDialog open onOpenChange={() => {}} level="tree" view="tree">
          <AgentMapTree root={root} background={[]} onOpen={() => {}} now={NOW} />
        </AgentMapDialog>
      </DesignProvider>,
    );
    expect(document.activeElement?.getAttribute("data-part")).toBe("agent-map-title");
  });

  it("the dialog sizes include the agent map widths", () => {
    const overlays = readFileSync(
      resolve(import.meta.dirname, "../src/styles/overlays.css"),
      "utf8",
    );
    expect(overlays).toContain('.cb-dialog[data-size="1100"]');
    expect(overlays).toContain("width: min(1100px, calc(100vw - 32px));");
    // Levels 2 and 3: the conversation's column plus the body padding and the border (AC2).
    expect(rule('.cb-amap-dialog[data-size="chat"]')).toContain(
      "width: min(calc(var(--cb-layout-chat) + 2 * var(--cb-space-4) + 2px), calc(100vw - 32px));",
    );
  });

  it("pads in the compact dialog rhythm: head space.2 space.4, body space.4, footer space.3 space.4 (AC6)", () => {
    expect(rule(".cb-amap-dialog")).toMatch(/padding: 0;/);
    expect(rule(".cb-amap-head")).toMatch(/padding: var\(--cb-space-2\) var\(--cb-space-4\);/);
    expect(rule(".cb-amap-content")).toMatch(/padding: var\(--cb-space-4\);/);
    expect(rule(".cb-amap")).not.toMatch(/padding/);
    expect(rule(".cb-amap-detail")).toMatch(/padding: var\(--cb-space-4\);/);
    expect(rule(".cb-amap-foot")).toMatch(/padding: var\(--cb-space-3\) var\(--cb-space-4\);/);
    // the transcript's thread fills the dialog: no layout gutter on either side
    expect(rule(".cb-amap-transcript")).toMatch(/padding: var\(--cb-space-4\);/);
  });
});

// ── Levels 2 and 3 ──────────────────────────────────────────────────────────

const D = F.detail;
const invoice = root.children.find((c) => c.id === "am_invoice") as AgentMapNode;
const calls: AgentToolCallRow[] = D.toolCalls.map((c) => ({
  id: c.id,
  tool: c.tool,
  summary: c.summary,
  running: c.running,
  ...(c.durationMs !== undefined ? { startedAt: NOW - c.durationMs } : {}),
  ...(c.range !== undefined ? { range: c.range } : {}),
}));
const detailBackground: AgentMapBackground[] = D.background.map((b) => ({
  kind: "task",
  id: b.id,
  description: b.description,
  status: b.status,
  startedAt: NOW - b.durationMs,
}));

type DetailOverrides = Partial<Parameters<typeof AgentDetail>[0]>;
const detail = (o: DetailOverrides = {}, { stop = true } = {}) => (
  <AgentDetail
    node={invoice}
    agentType={D.agentType}
    spawnedBy={D.spawnedBy}
    latestText={D.latestText}
    task={D.task}
    background={detailBackground}
    toolCalls={calls}
    onBack={() => {}}
    onClose={() => {}}
    onOpenParent={() => {}}
    onOpenTranscript={() => {}}
    {...(stop ? { onStop: () => {} } : {})}
    now={NOW}
    {...o}
  />
);

describe("AgentDetail (§6.16.28, level 2)", () => {
  it("tool calls list newest first, the running one with a pulse and a clock", () => {
    wrap(detail());
    const section = screen.getByRole("region", { name: "工具调用 7" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector('[data-part="agent-call-tool"]')?.textContent)).toEqual([
      "Bash",
      "Edit",
      "Bash",
      "Read",
      "Grep",
      "Bash",
      "Read",
    ]);
    const live = rows[0] as HTMLElement;
    expect(live.dataset.running).toBe("true");
    expect(live.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "running",
    );
    expect(live.querySelector('[data-part="agent-call-clock"]')?.textContent).toBe("12 秒");
    expect(live.textContent).toContain("运行核对脚本");
    // Finished rows: no dot, no clock; a range shows at the end.
    for (const r of rows.slice(1)) {
      expect(r.querySelector('[data-part="agent-dot"]')).toBeNull();
      expect(r.querySelector('[data-part="agent-call-clock"]')).toBeNull();
    }
    expect(rows[3]?.querySelector('[data-part="agent-call-range"]')?.textContent).toBe(
      "第 1–180 行",
    );
  });

  it("the head: back, status, title, close; meta lines with the spawning agent as a link", async () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    const onOpenParent = vi.fn();
    wrap(detail({ onBack, onClose, onOpenParent }));
    expect(screen.getByRole("heading", { name: "核对供应商发票与付款记录" })).toBeTruthy();
    expect(screen.getByText("运行中 · 财务助手 · opus 5.5 · 后台")).toBeTruthy();
    expect(screen.getByText("16分25秒 · 266.5k tokens")).toBeTruthy();
    expect(screen.getByText(D.latestText)).toBeTruthy();
    const spawned = screen.getByText(
      (_, el) => (el as HTMLElement | null)?.dataset.part === "agent-spawned-by",
    );
    expect(spawned.textContent).toBe("由 整理季度经营报告 派出");
    await userEvent.click(within(spawned).getByRole("button", { name: "整理季度经营报告" }));
    expect(onOpenParent).toHaveBeenCalledWith("am_root");
    await userEvent.click(screen.getByRole("button", { name: "返回智能体图" }));
    expect(onBack).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a running agent's footer has Open transcript and Stop", async () => {
    const onStop = vi.fn();
    const onOpenTranscript = vi.fn();
    wrap(detail({ onStop, onOpenTranscript }));
    const foot = document.querySelector('[data-part="agent-detail-foot"]') as HTMLElement;
    const buttons = within(foot).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["打开完整记录", "停止"]);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(onOpenTranscript).toHaveBeenCalled();
    await userEvent.click(buttons[1] as HTMLElement);
    expect(onStop).toHaveBeenCalled();
  });

  it("stopping: Stop stays in the Button's loading state, disabled and busy, and cannot be pressed", async () => {
    const onStop = vi.fn();
    const { rerender } = wrap(detail({ onStop, stopping: true }));
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(stop.getAttribute("data-state")).toBe("loading");
    await userEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
    // without onStop (the status already reads stopped elsewhere) a stop under way still shows
    rerender(
      <DesignProvider locale="zh">{detail({ stopping: true }, { stop: false })}</DesignProvider>,
    );
    expect(screen.getByRole("button", { name: "停止" }).getAttribute("aria-busy")).toBe("true");
  });

  it("a finished agent has no stop button", () => {
    const done: AgentMapNode = { ...invoice, status: "completed" };
    wrap(detail({ node: done }, { stop: false }));
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    const foot = document.querySelector('[data-part="agent-detail-foot"]') as HTMLElement;
    const buttons = within(foot).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["打开完整记录"]);
    // "Open transcript" fills the row: every footer button grows.
    expect(rule(".cb-amap-foot > .cb-btn")).toMatch(/flex: 1;/);
  });

  it("the task and background sections are collapsible", async () => {
    wrap(detail());
    const toggle = (name: RegExp) => screen.getByRole("button", { name });
    // Collapsed at first; the tool calls are open.
    expect(toggle(/^任务/).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(/^后台任务/).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(/^工具调用/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText(D.task)).toBeNull();
    expect(screen.queryByText("同步 ERP 付款流水")).toBeNull();

    await userEvent.click(toggle(/^任务/));
    expect(toggle(/^任务/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(D.task)).toBeTruthy();

    await userEvent.click(toggle(/^后台任务/));
    const bg = screen.getByRole("region", { name: "后台任务 1" });
    expect(within(bg).getByText("同步 ERP 付款流水")).toBeTruthy();
    expect(within(bg).getByText("1分35秒")).toBeTruthy();

    await userEvent.click(toggle(/^工具调用/));
    expect(screen.queryByText("运行核对脚本")).toBeNull();
    await userEvent.click(toggle(/^任务/));
    expect(screen.queryByText(D.task)).toBeNull();
  });

  it("titles the portal dialog with the agent's description", () => {
    wrap(
      <AgentMapDialog open onOpenChange={() => {}} level="detail">
        {detail()}
      </AgentMapDialog>,
    );
    expect(screen.getByRole("dialog", { name: "核对供应商发票与付款记录" })).toBeTruthy();
  });

  it("speaks English", () => {
    wrap(detail(), "en");
    expect(screen.getByText("Running · 财务助手 · opus 5.5 · Background")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open transcript" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tool calls/ })).toBeTruthy();
    const spawned = screen.getByText(
      (_, el) => (el as HTMLElement | null)?.dataset.part === "agent-spawned-by",
    );
    expect(spawned.textContent).toBe("Spawned by 整理季度经营报告");
  });
});

describe("TranscriptFrame (§6.16.28, level 3)", () => {
  const frame = (o: Partial<Parameters<typeof TranscriptFrame>[0]> = {}, { live = true } = {}) => (
    <TranscriptFrame
      node={invoice}
      agentType={D.agentType}
      spawnedBy={D.spawnedBy}
      {...(live ? { contextPercent: D.contextPercent, onStop: () => {} } : {})}
      onBack={() => {}}
      onClose={() => {}}
      {...o}
    >
      <p>the thread</p>
    </TranscriptFrame>
  );

  it("the status line holds the context use and Stop, no read-only copy, and no composer (AC1)", async () => {
    const onStop = vi.fn();
    wrap(frame({ onStop }));
    const status = document.querySelector('[data-part="agent-transcript-status"]') as HTMLElement;
    expect(status.textContent).toBe("上下文 31%停止");
    expect(status.textContent).not.toMatch(/只读|转达/);
    expect(within(status).getByText("上下文 31%")).toBeTruthy();
    await userEvent.click(within(status).getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalled();
    // The thread is the children, inside the conversation's thread column; nothing to type in.
    const thread = screen.getByText("the thread").closest('[data-part="agent-transcript"]');
    expect(thread).toBeTruthy();
    expect(screen.getByText("the thread").closest(".cb-conv-thread")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector('[data-part="composer"]')).toBeNull();
  });

  it("the head is one meta line; a finished agent has no stop and no context", async () => {
    const onBack = vi.fn();
    const done: AgentMapNode = { ...invoice, status: "completed" };
    wrap(frame({ node: done, onBack }, { live: false }));
    expect(document.querySelector('[data-part="agent-meta"]')?.textContent).toBe(
      "完成 · 财务助手 · opus 5.5 · 后台 · 由 整理季度经营报告 派出 · 16分25秒 · 266.5k tokens",
    );
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.queryByText(/上下文/)).toBeNull();
    // nothing to show: no status line at all
    expect(document.querySelector('[data-part="agent-transcript-status"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "返回智能体图" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("speaks English", () => {
    wrap(frame(), "en");
    expect(screen.queryByText(/Read-only|pass it on/)).toBeNull();
    expect(screen.getByText("Context 31%")).toBeTruthy();
  });

  it("stopping: the dense Stop stays in its loading state", async () => {
    const onStop = vi.fn();
    wrap(frame({ onStop, stopping: true }));
    const status = document.querySelector('[data-part="agent-transcript-status"]') as HTMLElement;
    const stop = within(status).getByRole("button", { name: "停止" });
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(stop.getAttribute("data-density")).toBe("dense");
    await userEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("the spawning agent is a link when onOpenParent is given", async () => {
    const onOpenParent = vi.fn();
    wrap(frame({ onOpenParent }));
    const meta = document.querySelector('[data-part="agent-meta"]') as HTMLElement;
    await userEvent.click(within(meta).getByRole("button", { name: "整理季度经营报告" }));
    expect(onOpenParent).toHaveBeenCalledWith("am_root");
  });

  it("a foreground agent (inBackground={false}) has no background label", () => {
    wrap(frame({ inBackground: false }));
    expect(document.querySelector('[data-part="agent-meta"]')?.textContent).toBe(
      "运行中 · 财务助手 · opus 5.5 · 由 整理季度经营报告 派出 · 16分25秒 · 266.5k tokens",
    );
  });
});

describe("AgentDetail background label", () => {
  it("a foreground agent (inBackground={false}) has no background label", () => {
    wrap(detail({ inBackground: false }));
    expect(screen.getByText("运行中 · 财务助手 · opus 5.5")).toBeTruthy();
    expect(screen.queryByText(/· 后台/)).toBeNull();
  });
});

// ── The Agent call block in the stream ──────────────────────────────────────

describe("AgentCallBlock (§6.16.15)", () => {
  const prompt = D.task;
  const call = (state: AgentCallState, o: { onOpen?: () => void } = {}) => (
    <AgentCallBlock
      description={invoice.description}
      prompt={prompt}
      state={state}
      onOpen={o.onOpen ?? (() => {})}
    />
  );
  const status = () =>
    document.querySelector('[data-part="agent-call-status"]') as HTMLElement | null;

  /** jsdom lays nothing out: make every element report a box taller than it shows. */
  const overflowing = (on: boolean) => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    for (const [key, value] of [
      ["scrollHeight", on ? 120 : 40],
      ["clientHeight", 40],
    ] as const) {
      Object.defineProperty(proto, key, { configurable: true, get: () => value });
    }
  };
  afterEach(() => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    delete proto.scrollHeight;
    delete proto.clientHeight;
  });

  it("the head is the tool name Agent and the task description; the body is IN with the prompt", () => {
    wrap(call({ status: "running" }));
    const head = document.querySelector('[data-part="agent-call-head"]') as HTMLElement;
    expect(head.textContent).toBe("Agent 核对供应商发票与付款记录");
    expect(within(head).getByText("Agent").dataset.part).toBe("agent-call-name");
    const io = document.querySelector('[data-part="tool-io"]') as HTMLElement;
    expect(io.querySelector('[data-part="tool-io-label"]')?.textContent).toBe("输入");
    expect(within(io).getByText(prompt).dataset.part).toBe("agent-call-prompt");
  });

  it("the prompt shows two lines and expands", async () => {
    overflowing(true);
    wrap(call({ status: "running" }));
    const p = screen.getByText(prompt);
    expect(p.dataset.expanded).toBe("false");
    // two lines with an ellipsis while collapsed
    expect(rule('.cb-agent-call-prompt[data-expanded="false"]')).toMatch(/-webkit-line-clamp: 2;/);
    expect(rule('.cb-agent-call-prompt[data-expanded="false"]')).toMatch(/overflow: hidden;/);
    const more = screen.getByRole("button", { name: "展开" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(more);
    expect(p.dataset.expanded).toBe("true");
    const less = screen.getByRole("button", { name: "收起" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    expect(less.getAttribute("aria-controls")).toBe(p.id);
    await userEvent.click(less);
    expect(p.dataset.expanded).toBe("false");
  });

  it("a prompt that fits in two lines has no toggle", () => {
    overflowing(false);
    wrap(call({ status: "running" }));
    expect(screen.queryByRole("button", { name: "展开" })).toBeNull();
  });

  it("a running call shows the current tool summary and updates when it changes", () => {
    const { rerender } = wrap(call({ status: "running", current: "Bash 运行核对脚本" }));
    const line = status() as HTMLElement;
    expect(line.dataset.status).toBe("running");
    const dot = line.querySelector('[data-part="agent-dot"]');
    expect(dot?.getAttribute("data-status")).toBe("running");
    expect(dot?.getAttribute("role")).toBe("img");
    expect(line.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "后台运行中：Bash 运行核对脚本",
    );
    rerender(
      <DesignProvider locale="zh">
        {call({ status: "running", current: "Read finance/q1/payments-2026-03.csv" })}
      </DesignProvider>,
    );
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "后台运行中：Read finance/q1/payments-2026-03.csv",
    );
    // no summary yet: the line says it works in the background
    rerender(<DesignProvider locale="zh">{call({ status: "running" })}</DesignProvider>);
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "后台运行中",
    );
  });

  it("a waiting call says it waits, with the warn dot", () => {
    wrap(call({ status: "waiting", current: "Bash 删除临时文件" }));
    expect(status()?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "waiting",
    );
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "后台等待中：Bash 删除临时文件",
    );
  });

  it("an ended call shows status, time and tokens", () => {
    const { rerender } = wrap(
      call({ status: "completed", durationMs: 985_000, tokens: 266_500, current: "x" }),
    );
    const text = () => status()?.querySelector('[data-part="agent-call-text"]') as HTMLElement;
    expect(text().textContent).toBe("完成 · 16分25秒 · 266.5k tokens");
    expect(status()?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "completed",
    );
    expect(screen.queryByText(/后台运行中/)).toBeNull();

    rerender(
      <DesignProvider locale="zh">
        {call({ status: "failed", durationMs: 192_000, tokens: 30_400 })}
      </DesignProvider>,
    );
    expect(text().textContent).toBe("失败 · 3分12秒 · 30.4k tokens");
    expect(within(text()).getByText("失败").dataset.part).toBe("fail-word");

    rerender(
      <DesignProvider locale="zh">
        {call({ status: "aborted", durationMs: 41_000, tokens: 950 })}
      </DesignProvider>,
    );
    expect(text().textContent).toBe("已停止 · 41 秒 · 950 tokens");
    expect(status()?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "aborted",
    );

    // unknown time and tokens are left out
    rerender(<DesignProvider locale="zh">{call({ status: "completed" })}</DesignProvider>);
    expect(text().textContent).toBe("完成");
  });

  it("the action calls onOpen, running or ended", async () => {
    const onOpen = vi.fn();
    const { rerender } = wrap(
      call({ status: "running", current: "Bash 运行核对脚本" }, { onOpen }),
    );
    await userEvent.click(screen.getByRole("button", { name: "在智能体图中查看" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(
      <DesignProvider locale="zh">
        {call({ status: "completed", durationMs: 1000, tokens: 10 }, { onOpen })}
      </DesignProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "在智能体图中查看" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("a foreground child (a fork skill's) has the neutral running copy", () => {
    const { rerender } = wrap(
      call({ status: "running", current: "Bash 运行核对脚本", background: false }),
    );
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "运行中：Bash 运行核对脚本",
    );
    rerender(
      <DesignProvider locale="zh">{call({ status: "waiting", background: false })}</DesignProvider>,
    );
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe("等待中");
  });

  it("a refused call shows its reason and, with no child, no action", () => {
    wrap(
      <AgentCallBlock
        description="Spy"
        prompt="look"
        state={{ status: "failed", refusal: 'Unknown subagent_type "nope".\nMore detail' }}
      />,
    );
    const text = status()?.querySelector('[data-part="agent-call-text"]') as HTMLElement;
    expect(text.textContent).toBe('失败 · Unknown subagent_type "nope".');
    expect(text.getAttribute("title")).toBe('Unknown subagent_type "nope".\nMore detail');
    expect(screen.queryByRole("button", { name: "在智能体图中查看" })).toBeNull();
  });

  it("speaks English", () => {
    overflowing(true);
    wrap(call({ status: "running", current: "Bash 运行核对脚本" }), "en");
    expect(status()?.querySelector('[data-part="agent-call-text"]')?.textContent).toBe(
      "Working in the background: Bash 运行核对脚本",
    );
    expect(screen.getByRole("button", { name: "View in agent map" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(document.querySelector('[data-part="tool-io-label"]')?.textContent).toBe("IN");
  });
});

describe("the transcript is a pane (box-in-box review)", () => {
  it("a CodeBlock in the transcript frame inside the dialog stays framed, and nothing nests", () => {
    // mounted inside a Card: the box context reaches through the portal, the pane resets it
    wrap(
      <Card>
        <AgentMapDialog open onOpenChange={() => {}} level="transcript">
          <TranscriptFrame
            node={invoice}
            agentType={D.agentType}
            spawnedBy={D.spawnedBy}
            onBack={() => {}}
            onClose={() => {}}
          >
            <CodeBlock language="bash" text="pnpm test" />
          </TranscriptFrame>
        </AgentMapDialog>
      </Card>,
    );
    const code = document.querySelector('[data-part="code-block"]') as HTMLElement;
    expect(code.closest(".cb-dialog")).not.toBeNull();
    expect(code.getAttribute("data-framed")).toBe("true");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("levels 1 and 2 are a dialog box: a CodeBlock there draws its unboxed form", () => {
    wrap(
      <AgentMapDialog open onOpenChange={() => {}} level="tree">
        <CodeBlock language="bash" text="pnpm test" />
      </AgentMapDialog>,
    );
    const code = document.querySelector('[data-part="code-block"]') as HTMLElement;
    expect(code.getAttribute("data-framed")).toBe("false");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
