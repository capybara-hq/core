import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import TrajectoryPage from "../src/app/[locale]/(app)/trajectories/[conversationId]/page";
import TrajectoriesPage from "../src/app/[locale]/(app)/trajectories/page";
import { activeNavOf } from "../src/components/shell/nav";
import { type TrajectoryRun, trajectorySpans } from "../src/lib/trajectories";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const msgs = { zh, en } as const;
const ORG = "/api/v1/orgs/o1";
const DETAIL = `${ORG}/trajectories/c1`;

/** 管理员以外：agent 负责人（成员）。 */
const OWNER_MEMBER = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const at = (ms: number) => new Date(Date.UTC(2026, 9, 22, 8, 0, 0) + ms).toISOString();
const USAGE = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 };

/** 一次运行：第 0 步模型失败一次后兜底成功并调用工具（先审批），第 1 步模型回复文本。 */
function run(over: Partial<TrajectoryRun> = {}, cost: number | null = 0.0032): TrajectoryRun {
  return {
    runId: "r1",
    agentVersion: 3,
    triggerAccountId: "a1",
    startedAt: at(0),
    endedAt: at(9000),
    end: { kind: "finished", detail: "completed" },
    steps: [
      {
        step: 0,
        modelCalls: [
          {
            seq: 3,
            step: 0,
            attempt: 0,
            provider: "anthropic",
            model: "claude-x",
            fallback: false,
            startedAt: at(100),
            latencyMs: null,
            outcome: "failed",
            usage: null,
            cost: null,
            request: { fromSeq: 1, toSeq: 2, summarySeq: null, systemHash: "h", reminderSeqs: [] },
          },
          {
            seq: 4,
            step: 0,
            attempt: 1,
            provider: "model-fake",
            model: "fake-1",
            fallback: true,
            startedAt: at(500),
            latencyMs: 1500,
            outcome: "ok",
            usage: USAGE,
            cost,
            request: {
              fromSeq: 1,
              toSeq: 2,
              summarySeq: null,
              systemHash: "h",
              reminderSeqs: [],
              params: { temperature: 0.2 },
              tools: [
                { key: "fixture__delete_item", specHash: "s1" },
                { key: "ask_user", specHash: "s2" },
              ],
            },
          },
        ],
        toolCalls: [
          {
            callId: "call-1",
            step: 0,
            toolKey: "fixture__delete_item",
            input: { id: "x1" },
            startedAt: at(4000),
            durationMs: 250,
            result: { content: "deleted x1", isError: false },
            approval: {
              approvalId: "ap1",
              requestedAt: at(2100),
              decision: "approved",
              scope: "once",
              byAccountId: "a1",
              decidedAt: at(4000),
            },
            question: null,
          },
        ],
        text: "",
        stopReason: "tool_use",
      },
      {
        step: 1,
        modelCalls: [
          {
            seq: 9,
            step: 1,
            attempt: 0,
            provider: "model-fake",
            model: "fake-1",
            fallback: false,
            startedAt: at(4300),
            latencyMs: 700,
            outcome: "ok",
            usage: USAGE,
            cost,
            request: { fromSeq: 1, toSeq: 8, summarySeq: null, systemHash: "h", reminderSeqs: [] },
          },
        ],
        toolCalls: [],
        text: "Deleted it.",
        stopReason: "end_turn",
      },
    ],
    totals: {
      usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 40, cacheWriteTokens: 0 },
      cost: cost === null ? null : cost * 2,
      modelCalls: 3,
      toolCalls: 1,
      durationMs: 9000,
    },
    ...over,
  };
}

const detailBody = (runs: TrajectoryRun[], next: string | null = null) => ({
  conversation: { id: "c1", agentId: "ag1", accountId: "a2", title: "Clean up", kind: "chat" },
  runs,
  currency: "USD",
  next,
});

beforeEach(() => resetNavigation("/trajectories/c1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trajectorySpans", () => {
  it("层级：run → step → model / tool → wait；偏移相对最早一次运行的开始", () => {
    const second = run({
      runId: "r2",
      startedAt: at(20_000),
      endedAt: null,
      end: null,
      totals: { ...run().totals, durationMs: null },
      steps: [
        {
          step: 0,
          modelCalls: [
            {
              ...(run().steps[1]?.modelCalls[0] as TrajectoryRun["steps"][0]["modelCalls"][0]),
              seq: 20,
              step: 0,
              startedAt: at(20_100),
              latencyMs: null,
              outcome: "pending",
              usage: null,
              cost: null,
            },
          ],
          toolCalls: [],
          text: "",
          stopReason: null,
        },
      ],
    });
    const spans = trajectorySpans([run(), second]);
    expect(spans.map((s) => [s.id, s.parentId ?? null, s.kind])).toEqual([
      ["run:r1", null, "run"],
      ["step:r1:0", "run:r1", "step"],
      ["model:r1:3", "step:r1:0", "model"],
      ["model:r1:4", "step:r1:0", "model"],
      ["tool:r1:call-1", "step:r1:0", "tool"],
      ["approval:r1:ap1", "tool:r1:call-1", "wait"],
      ["step:r1:1", "run:r1", "step"],
      ["model:r1:9", "step:r1:1", "model"],
      ["run:r2", null, "run"],
      ["step:r2:0", "run:r2", "step"],
      ["model:r2:20", "step:r2:0", "model"],
    ]);
    const by = new Map(spans.map((s) => [s.id, s]));
    expect(by.get("run:r1")).toMatchObject({ startMs: 0, durationMs: 9000, status: "ok" });
    // 步骤：从第一次模型调用开始，到最后一个子 span 结束（工具 4000 + 250）
    expect(by.get("step:r1:0")).toMatchObject({ startMs: 100, durationMs: 4150, status: "ok" });
    expect(by.get("model:r1:3")).toMatchObject({
      startMs: 100,
      durationMs: null,
      status: "error",
      label: "anthropic/claude-x",
    });
    expect(by.get("model:r1:4")).toMatchObject({
      startMs: 500,
      durationMs: 1500,
      status: "ok",
      meta: "↑1,020 ↓100",
    });
    expect(by.get("tool:r1:call-1")).toMatchObject({
      startMs: 4000,
      durationMs: 250,
      status: "ok",
      label: "fixture__delete_item",
    });
    // 审批等待 = decidedAt − requestedAt
    expect(by.get("approval:r1:ap1")).toMatchObject({
      startMs: 2100,
      durationMs: 1900,
      status: "ok",
    });
    // 进行中的运行：运行、步骤、模型调用都是 pending，时长未知
    expect(by.get("run:r2")).toMatchObject({
      startMs: 20_000,
      durationMs: null,
      status: "pending",
    });
    expect(by.get("step:r2:0")).toMatchObject({
      startMs: 20_100,
      durationMs: null,
      status: "pending",
    });
    expect(by.get("model:r2:20")).toMatchObject({ status: "pending", durationMs: null });
  });

  it("失败 / 中止的运行与出错的工具为 error；未决定的提问在进行中的运行里为 pending", () => {
    const failed = run({ end: { kind: "failed", detail: "model.unavailable" } });
    const base = run().steps[0] as TrajectoryRun["steps"][0];
    const asking = run({
      runId: "r3",
      end: null,
      endedAt: null,
      steps: [
        {
          ...base,
          toolCalls: [
            {
              callId: "q1",
              step: 0,
              toolKey: "ask_user",
              input: { question: "?" },
              startedAt: at(3000),
              durationMs: null,
              result: null,
              approval: null,
              question: { questionId: "qq", askedAt: at(3000), outcome: null, byAccountId: null },
            },
            {
              callId: "bad",
              step: 0,
              toolKey: "fixture__delete_item",
              input: {},
              startedAt: at(3500),
              durationMs: 10,
              result: { content: "boom", isError: true },
              approval: null,
              question: null,
            },
          ],
        },
      ],
    });
    const spans = new Map(trajectorySpans([failed, asking]).map((s) => [s.id, s]));
    expect(spans.get("run:r1")?.status).toBe("error");
    expect(spans.get("tool:r3:q1")).toMatchObject({ status: "pending", durationMs: null });
    expect(spans.get("question:r3:qq")).toMatchObject({ kind: "wait", status: "pending" });
    expect(spans.get("tool:r3:bad")?.status).toBe("error");
    expect(trajectorySpans([])).toEqual([]);
  });
});

describe("轨迹详情（TracePage）", () => {
  it.each(["zh", "en"] as const)(
    "瀑布 + 详情：选中 span 后详情切换；审计提示与指标（%s）",
    async (locale) => {
      const m = msgs[locale].trajectories;
      const calls = stubApi({ [`GET ${DETAIL}`]: () => json(200, detailBody([run()])) });
      const { container } = renderPage(<TrajectoryPage />, { locale });
      expect(container.querySelector('[data-template="TracePage"]')).not.toBeNull();
      const list = await screen.findByRole("tree", { name: m.detail.waterfall });
      // 按运行分页读：不一次读全对话
      expect(calls[0]?.url).toBe(`${DETAIL}?limit=10`);
      expect(screen.getByText(m.detail.audited)).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Clean up" })).toBeTruthy();
      // 页头指标：总 token、成本（估算）、调用数、耗时
      const metrics = container.querySelector(".cb-pageheader-metrics") as HTMLElement;
      const metric = (label: string) =>
        within(metrics).getByText(label).parentElement as HTMLElement;
      // 输入（含缓存读 / 写）+ 输出
      expect(within(metric(m.detail.metrics.tokens)).getByText("2,240")).toBeTruthy();
      expect(within(metric(m.detail.metrics.cost)).getByText("0.0064 USD")).toBeTruthy();
      // 模型调用 3 + 工具调用 1
      expect(within(metric(m.detail.metrics.calls)).getByText("4")).toBeTruthy();
      expect(within(metric(m.detail.metrics.duration)).getByText("9.0s")).toBeTruthy();

      const user = userEvent.setup();
      // 缺省选中最近一次运行
      const detail = () => screen.getByRole("region", { name: m.detail.region });
      expect(within(detail()).getByText(m.detail.run.title.replace("{id}", "r1"))).toBeTruthy();

      // 模型调用：供应商 / 模型、尝试 / 兜底、token、延迟、成本、参数、工具 key
      await user.click(within(list).getAllByText("model-fake/fake-1")[0] as HTMLElement);
      const d = detail();
      expect(within(d).getByText(m.detail.model.provider)).toBeTruthy();
      expect(within(d).getByText("model-fake")).toBeTruthy();
      expect(within(d).getByText("fake-1")).toBeTruthy();
      expect(within(d).getByText(m.detail.model.attemptValue.replace("{n}", "2"))).toBeTruthy();
      expect(within(d).getByText(m.detail.model.fallbackYes)).toBeTruthy();
      expect(within(d).getByText(m.detail.model.cost)).toBeTruthy();
      expect(within(d).getByText("0.0032 USD")).toBeTruthy();
      expect(within(d).getByText("1.5s")).toBeTruthy();
      expect(within(d).getByText("temperature=0.2")).toBeTruthy();
      expect(within(d).getByText("fixture__delete_item, ask_user")).toBeTruthy();

      // 工具调用：参数、结果、耗时、审批链
      await user.click(within(list).getByText("fixture__delete_item"));
      const tool = detail();
      expect(within(tool).getByText(/"id": "x1"/)).toBeTruthy();
      expect(within(tool).getByText("deleted x1")).toBeTruthy();
      expect(within(tool).getByText("250ms")).toBeTruthy();
      expect(within(tool).getByText(m.detail.tool.decisions.approved)).toBeTruthy();
      expect(within(tool).getByText(m.detail.tool.scopes.once)).toBeTruthy();
      // 步骤：回复正文
      await user.click(within(list).getByText("step 1"));
      expect(within(detail()).getByText("Deleted it.")).toBeTruthy();
    },
  );

  it("没有价格时成本显示「—」", async () => {
    stubApi({ [`GET ${DETAIL}`]: () => json(200, detailBody([run({}, null)])) });
    const { container } = renderPage(<TrajectoryPage />);
    const list = await screen.findByRole("tree", { name: en.trajectories.detail.waterfall });
    // 页头：合计成本未知
    const metrics = container.querySelector(".cb-pageheader-metrics") as HTMLElement;
    const header = within(metrics).getByText(en.trajectories.detail.metrics.cost)
      .parentElement as HTMLElement;
    expect(within(header).getByText("—")).toBeTruthy();
    await userEvent.setup().click(within(list).getAllByText("model-fake/fake-1")[0] as HTMLElement);
    const d = screen.getByRole("region", { name: en.trajectories.detail.region });
    const row = within(d).getByText(en.trajectories.detail.model.cost).parentElement as HTMLElement;
    expect(within(row).getByText("—")).toBeTruthy();
  });

  it("加载更早的运行：带 before 再读一页，拼在前面", async () => {
    const older = run({ runId: "r0", startedAt: at(-60_000), endedAt: at(-50_000) });
    const calls = stubApi({
      [`GET ${DETAIL}?limit=10`]: () => json(200, detailBody([run()], "r1")),
      [`GET ${DETAIL}?limit=10&before=r1`]: () => json(200, detailBody([older], null)),
    });
    renderPage(<TrajectoryPage />);
    await screen.findByRole("tree");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.trajectories.detail.loadEarlier }));
    await waitFor(() => expect(screen.getAllByText(/^run · v3$/)).toHaveLength(2));
    expect(calls.map((c) => c.url)).toEqual([`${DETAIL}?limit=10`, `${DETAIL}?limit=10&before=r1`]);
    expect(screen.queryByRole("button", { name: en.trajectories.detail.loadEarlier })).toBeNull();
  });

  it("非管理员（agent 负责人）看不到「加入评测集」", async () => {
    stubApi({ [`GET ${DETAIL}`]: () => json(200, detailBody([run()])) });
    renderPage(<TrajectoryPage />, { me: OWNER_MEMBER });
    await screen.findByRole("tree");
    expect(screen.queryByRole("button", { name: en.trajectories.addToSet.action })).toBeNull();
  });

  it("管理员把选中的运行加入该 agent 的评测集", async () => {
    const calls = stubApi({
      [`GET ${DETAIL}`]: () => json(200, detailBody([run()])),
      [`GET ${ORG}/eval-sets`]: () =>
        json(200, {
          sets: [
            {
              id: "set-other",
              agentId: "ag2",
              name: "Other",
              description: "",
              rubric: null,
              caseCount: 0,
              createdAt: at(0),
            },
            {
              id: "set-1",
              agentId: "ag1",
              name: "Regression",
              description: "",
              rubric: null,
              caseCount: 2,
              createdAt: at(0),
            },
          ],
        }),
      [`POST ${ORG}/eval-sets/set-1/cases`]: () => json(201, { case: { id: "case-1" } }),
    });
    renderPage(<TrajectoryPage />);
    await screen.findByRole("tree");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.trajectories.addToSet.action }));
    const dialog = await screen.findByRole("dialog", { name: en.trajectories.addToSet.title });
    const select = within(dialog).getByRole("combobox", { name: en.trajectories.addToSet.set });
    // 只列该 agent 的评测集
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Regression"]);
    await user.click(within(dialog).getByRole("button", { name: en.trajectories.addToSet.submit }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url === `${ORG}/eval-sets/set-1/cases`),
      ).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(bodyOf(post)).toEqual({ conversationId: "c1", runId: "r1" });
    expect(
      await screen.findByText(en.trajectories.addToSet.added.replace("{name}", "Regression")),
    ).toBeTruthy();
  });

  it("无权查看：内核 404 显示未找到", async () => {
    stubApi({
      [`GET ${DETAIL}`]: () =>
        json(404, { error: { code: "trajectory.not_found", message: "Trajectory not found" } }),
    });
    renderPage(<TrajectoryPage />);
    expect(await screen.findByText(`✗ ${en.errors.trajectory.not_found}`)).toBeTruthy();
  });
});

describe("运行记录列表（ListPage）", () => {
  const LIST = `${ORG}/trajectories`;
  const item = (id: string, status: string | null) => ({
    conversationId: id,
    agentId: "ag1",
    agentName: "Helper",
    accountId: "a2",
    title: id === "c1" ? "Clean up" : null,
    updatedAt: at(0),
    lastRun: status === null ? null : { runId: `run-${id}`, status, startedAt: at(0) },
  });

  it("Rail 按 agent、状态筛选；打开一行进详情", async () => {
    resetNavigation("/trajectories");
    const calls = stubApi({
      [`GET ${ORG}/agents`]: () =>
        json(200, {
          agents: [
            {
              id: "ag1",
              orgId: "o1",
              ownerAccountId: "a1",
              visibility: "org",
              currentVersion: 1,
              definition: { name: "Helper" },
              updatedAt: at(0),
            },
          ],
        }),
      [`GET ${LIST}`]: () =>
        json(200, { items: [item("c1", "completed"), item("c2", null)], next: null }),
    });
    const { container } = renderPage(<TrajectoriesPage />, { locale: "zh" });
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const table = await screen.findByRole("table", { name: zh.trajectories.title });
    expect(within(table).getByText("Clean up")).toBeTruthy();
    expect(within(table).getByText(zh.trajectories.untitled)).toBeTruthy();
    expect(within(table).getByText(`✓ ${zh.trajectories.status.completed}`)).toBeTruthy();
    const lastList = () => calls.filter((c) => c.url.startsWith(LIST)).at(-1)?.url;
    expect(lastList()).toBe(`${LIST}?limit=50`);

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: zh.trajectories.filters.agent }),
      "ag1",
    );
    await waitFor(() => expect(lastList()).toBe(`${LIST}?limit=50&agentId=ag1`));
    await user.click(screen.getByRole("radio", { name: zh.trajectories.status.failed }));
    await waitFor(() => expect(lastList()).toBe(`${LIST}?limit=50&agentId=ag1&status=failed`));

    await user.click(await screen.findByText("Clean up"));
    expect(router.push).toHaveBeenCalledWith("/trajectories/c1");
  });
});

describe("导航", () => {
  it("轨迹页归在「评测」下", () => {
    expect(activeNavOf("/trajectories")).toBe("evals");
    expect(activeNavOf("/trajectories/c1")).toBe("evals");
  });
});
