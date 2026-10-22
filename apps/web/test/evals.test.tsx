import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import EvalCasePage from "../src/app/[locale]/(app)/evals/[setId]/cases/[caseId]/page";
import EvalSetPage from "../src/app/[locale]/(app)/evals/[setId]/page";
import RunWizardPage from "../src/app/[locale]/(app)/evals/[setId]/run/page";
import NewEvalSetPage from "../src/app/[locale]/(app)/evals/new/page";
import EvalsPage from "../src/app/[locale]/(app)/evals/page";
import EvalRunPage from "../src/app/[locale]/(app)/evals/runs/[runId]/page";
import { activeNavOf } from "../src/components/shell/nav";
import { type EvalResult, type EvalRun, rowOf } from "../src/lib/evals";
import type { TrajectoryRun } from "../src/lib/trajectories";
import { bodyOf, type Call, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => ({ setId: "s1", runId: "er1", caseId: "k1" }),
}));

const msgs = { zh, en } as const;
const ORG = "/api/v1/orgs/o1";
const SETS = `${ORG}/eval-sets`;
const T = "2026-10-22T08:00:00.000Z";
const E = en.evals;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const CASES = [
  {
    id: "k1",
    sourceConversationId: "c1",
    sourceRunId: "r1",
    agentVersion: 2,
    title: "Delete the stale item",
    replayableSteps: 2,
    createdAt: T,
  },
  {
    id: "k2",
    sourceConversationId: "c2",
    sourceRunId: "r2",
    agentVersion: 3,
    title: "Summarize the doc",
    replayableSteps: 1,
    createdAt: T,
  },
];

const SET = {
  id: "s1",
  agentId: "ag1",
  name: "Regression",
  description: "Nightly checks",
  rubric: null,
  caseCount: 2,
  createdAt: T,
};

const AGENT = {
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 3,
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
  },
  updatedAt: T,
};

const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        { id: "fake-1", displayName: "Fake 1", capabilities: { reasoning: false }, parameters: [] },
        {
          id: "fake-2",
          displayName: "Fake 2",
          capabilities: { reasoning: false },
          parameters: [
            {
              key: "model-fake.level",
              schema: { type: "integer", minimum: 1, maximum: 3 },
              label: { zh: "级别", en: "Level" },
            },
          ],
        },
      ],
    },
  ],
};

const purposes = (mapped: boolean) => ({
  purposes: [
    {
      purpose: "eval",
      kind: "chat",
      label: { zh: "评测评委", en: "Eval judge" },
      declaredBy: "kernel",
      default: null,
      override: null,
      effective: mapped ? { model: { provider: "model-fake", model: "fake-1" }, params: {} } : null,
    },
  ],
});

const ESTIMATE = {
  cases: 2,
  modelRequests: 3,
  judgeRequests: 3,
  estimatedTokens: 12345,
  estimatedCost: 0.0123,
  judgeTokens: 2345,
  judgeCost: 0.002,
  currency: "USD",
};

/** 成本按界面语言的货币格式（Intl，最多 6 位小数）。 */
const usd = (v: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(v);

/** 结果的轻量行（结果表与轮询读的 `view=light`）。 */
const light = (r: EvalResult) => rowOf(r, T);

const SUMMARY = {
  done: 2,
  errors: 0,
  skipped: 0,
  toolCallsMatchRate: 0.5,
  meanTextSimilarity: 0.75,
  judgePassRate: 1,
  judgeErrors: 0,
  humanPassRate: null,
  labeled: 0,
  drifted: 0,
};

function evalRun(over: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "er1",
    setId: "s1",
    mode: "step",
    candidate: { model: { provider: "model-fake", model: "fake-2" } },
    judge: true,
    status: "completed",
    tokenCap: 1_000_000,
    tokensUsed: 4200,
    casesTotal: 2,
    casesDone: 2,
    estimate: ESTIMATE,
    summary: SUMMARY,
    error: null,
    createdAt: T,
    finishedAt: T,
    ...over,
  };
}

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    id: "res1",
    caseId: "k1",
    step: 0,
    modelCallSeq: 4,
    status: "done",
    baseline: {
      content: [
        { type: "text", text: "I will delete it.\nDone." },
        { type: "tool_call", id: "t1", name: "fixture__delete_item", input: { id: "x1" } },
      ],
      stopReason: "tool_use",
    },
    candidate: {
      content: [
        { type: "text", text: "I will remove it.\nDone." },
        { type: "tool_call", id: "t2", name: "fixture__delete_item", input: { id: "x2" } },
      ],
      stopReason: "tool_use",
      provider: "model-fake",
      model: "fake-2",
    },
    diff: {
      toolCalls: [
        {
          index: 0,
          kind: "args_changed",
          baseline: { name: "fixture__delete_item", input: { id: "x1" } },
          candidate: { name: "fixture__delete_item", input: { id: "x2" } },
        },
      ],
      toolCallsMatch: false,
      textSimilarity: 0.6,
      stopReasonMatch: true,
    },
    judge: {
      verdict: "fail",
      score: 2,
      reason: "Deleted the wrong item.",
      provider: "model-fake",
      model: "fake-1",
    },
    judgeStatus: "done",
    drift: [],
    error: null,
    evalConversationId: null,
    label: null,
    labelNote: null,
    labeledBy: null,
    labeledAt: null,
    ...over,
  };
}

beforeEach(() => resetNavigation("/evals"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("导航", () => {
  it("/evals 与运行记录都归在一级导航「评测」下", () => {
    expect(activeNavOf("/evals")).toBe("evals");
    expect(activeNavOf("/evals/s1/run")).toBe("evals");
    expect(activeNavOf("/trajectories/c1")).toBe("evals");
  });
});

describe("评测集列表（ListPage）", () => {
  it.each(["zh", "en"] as const)(
    "列出评测集与所属 agent；有新建与运行记录入口（%s）",
    async (locale) => {
      const m = msgs[locale].evals;
      stubApi({
        [`GET ${SETS}`]: () => json(200, { sets: [SET] }),
        [`GET ${ORG}/agents`]: () => json(200, { agents: [AGENT] }),
      });
      const { container } = renderPage(<EvalsPage />, { locale });
      expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
      const table = await screen.findByRole("table", { name: m.title });
      const row = await within(table).findByRole("row", { name: /Regression/ });
      await waitFor(() => expect(within(row).getByText("Helper")).toBeTruthy());
      expect(within(row).getByText("2")).toBeTruthy();
      expect(screen.getByRole("link", { name: m.new }).getAttribute("href")).toBe("/evals/new");
      expect(screen.getByRole("link", { name: m.runHistory }).getAttribute("href")).toBe(
        "/trajectories",
      );
      await userEvent.setup().click(within(row).getByText("Regression"));
      expect(router.push).toHaveBeenCalledWith("/evals/s1");
    },
  );

  it("没有评测集时显示空状态", async () => {
    stubApi({
      [`GET ${SETS}`]: () => json(200, { sets: [] }),
      [`GET ${ORG}/agents`]: () => json(200, { agents: [AGENT] }),
    });
    renderPage(<EvalsPage />);
    expect(await screen.findByText(E.empty)).toBeTruthy();
  });
});

describe("新建评测集（FormPage）", () => {
  it("选 agent，填名称、说明与评分标准后创建，跳到详情", async () => {
    const calls = stubApi({
      [`GET ${ORG}/agents`]: () => json(200, { agents: [AGENT] }),
      [`POST ${SETS}`]: () => json(201, { set: { ...SET, rubric: "Be exact." } }),
    });
    const { container } = renderPage(<NewEvalSetPage />);
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    const user = userEvent.setup();
    const agent = await screen.findByRole("combobox", { name: E.form.agentLabel });
    await waitFor(() => expect((agent as HTMLSelectElement).value).toBe("ag1"));
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(E.form.nameLabel) }),
      "Regression",
    );
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(E.form.descriptionLabel) }),
      "Nightly checks",
    );
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(E.form.rubricLabel) }),
      "Be exact.",
    );
    await user.click(screen.getByRole("button", { name: E.form.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/evals/s1"));
    const post = calls.find((c) => c.method === "POST");
    expect(bodyOf(post)).toEqual({
      agentId: "ag1",
      name: "Regression",
      description: "Nightly checks",
      rubric: "Be exact.",
    });
  });
});

describe("评测集详情（DetailPage）", () => {
  const routes = (over: Record<string, () => Response> = {}) => ({
    [`GET ${SETS}/s1`]: () => json(200, { set: { ...SET, cases: CASES } }),
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: AGENT }),
    [`GET ${SETS}/s1/runs`]: () => json(200, { runs: [evalRun()] }),
    ...over,
  });

  it("用例与运行两个标签页；点用例看快照轨迹，点运行看结果", async () => {
    stubApi(routes());
    const { container } = renderPage(<EvalSetPage />);
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    const user = userEvent.setup();
    const cases = await screen.findByRole("table", { name: E.set.casesLabel });
    await user.click(within(cases).getByText("Delete the stale item"));
    expect(router.push).toHaveBeenLastCalledWith("/evals/s1/cases/k1");
    expect(screen.getByRole("link", { name: E.set.run }).getAttribute("href")).toBe(
      "/evals/s1/run",
    );
    await user.click(screen.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }));
    const runs = await screen.findByRole("table", { name: E.set.runsLabel });
    expect(within(runs).getByText(E.mode.step)).toBeTruthy();
    expect(within(runs).getByText("2/2")).toBeTruthy();
    await user.click(within(runs).getByText(E.mode.step));
    expect(router.push).toHaveBeenLastCalledWith("/evals/runs/er1");
  });

  it("从对话抽样：弹窗提交参数，提示加入与跳过的个数并重读", async () => {
    let reads = 0;
    const calls = stubApi(
      routes({
        [`GET ${SETS}/s1`]: () => {
          reads++;
          return json(200, { set: { ...SET, cases: CASES } });
        },
        [`POST ${SETS}/s1/cases/sample`]: () => json(200, { added: 3, skipped: 1 }),
      }),
    );
    renderPage(<EvalSetPage />);
    await screen.findByRole("table", { name: E.set.casesLabel });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: E.set.sample }));
    const dialog = await screen.findByRole("dialog", { name: E.sample.title });
    const count = within(dialog).getByRole("spinbutton", { name: E.sample.count });
    await user.clear(count);
    await user.type(count, "5");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: E.sample.status }),
      "failed",
    );
    await user.click(within(dialog).getByRole("button", { name: E.sample.submit }));
    expect(await screen.findByText(fill(E.sample.done, { added: 3, skipped: 1 }))).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith("/cases/sample"));
    expect(bodyOf(post)).toEqual({ count: 5, status: "failed", minToolCalls: 0 });
    await waitFor(() => expect(reads).toBe(2));
  });

  it("移除用例", async () => {
    const calls = stubApi(routes({ [`DELETE ${SETS}/s1/cases/k2`]: () => noContent() }));
    renderPage(<EvalSetPage />);
    const cases = await screen.findByRole("table", { name: E.set.casesLabel });
    const user = userEvent.setup();
    const row = within(cases).getByRole("row", { name: /Summarize the doc/ });
    await user.click(within(row).getByRole("button", { name: /./ }));
    await user.click(await screen.findByRole("menuitem", { name: E.set.removeCase }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("用例快照轨迹（TracePage）", () => {
  it("复用轨迹查看器：瀑布与详情，页头回到评测集", async () => {
    const run: TrajectoryRun = {
      runId: "r1",
      agentVersion: 2,
      triggerAccountId: "a1",
      startedAt: T,
      endedAt: T,
      end: { kind: "finished", detail: "completed" },
      steps: [],
      totals: {
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: null,
        modelCalls: 0,
        toolCalls: 0,
        durationMs: 0,
      },
    };
    stubApi({
      [`GET ${SETS}/s1/cases/k1`]: () =>
        json(200, { case: CASES[0], trajectory: [run], currency: "USD" }),
    });
    const { container } = renderPage(<EvalCasePage />);
    expect(container.querySelector('[data-template="TracePage"]')).not.toBeNull();
    const tree = await screen.findByRole("tree", { name: en.trajectories.detail.waterfall });
    expect(within(tree).getByText("run · v2")).toBeTruthy();
    expect(screen.getByText(en.trajectories.detail.audited)).toBeTruthy();
    expect(screen.getByRole("link", { name: `${E.title} /` }).getAttribute("href")).toBe(
      "/evals/s1",
    );
  });
});

describe("运行向导（WizardPage）", () => {
  /** 估算响应：上限按请求回显（缺省为部署默认）。 */
  const estimated = (c: Call, over: Partial<typeof ESTIMATE> = {}) => {
    const body = bodyOf(c) as { tokenCap?: number };
    return {
      estimate: { ...ESTIMATE, ...over },
      defaultTokenCap: 1_000_000,
      maxTokenCap: 20_000_000,
      effectiveTokenCap: body.tokenCap ?? 1_000_000,
    };
  };
  const estimates = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/runs/estimate"));

  const routes = (
    mapped: boolean,
    over: Record<string, (c: Call) => Response | Promise<Response>> = {},
  ) => ({
    [`GET ${SETS}/s1`]: () => json(200, { set: { ...SET, cases: CASES } }),
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: AGENT }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/model-purposes`]: () => json(200, purposes(mapped)),
    [`POST ${SETS}/s1/runs/estimate`]: (c: Call) => json(200, estimated(c)),
    [`POST ${SETS}/s1/runs`]: () =>
      json(201, { run: evalRun({ status: "queued", summary: null }) }),
    ...over,
  });

  const actionRow = () => document.querySelector(".cb-actionrow") as HTMLElement;

  it.each(["zh", "en"] as const)(
    "三步：候选 → 评委与上限 → 估算数字与上限，确认后开始运行（%s）",
    async (locale) => {
      const m = msgs[locale].evals;
      const calls = stubApi(routes(true));
      const { container } = renderPage(<RunWizardPage />, { locale });
      expect(container.querySelector('[data-template="WizardPage"]')).not.toBeNull();
      const user = userEvent.setup();
      // 1. 模式与候选
      const model = await screen.findByRole("combobox", { name: m.wizard.model });
      await waitFor(() => expect(within(model).getAllByRole("option").length).toBeGreaterThan(1));
      await user.click(screen.getByRole("radio", { name: new RegExp(m.mode.step) }));
      await user.selectOptions(model, "model-fake/fake-2");
      // 选了候选模型后出现它的参数（复用 ModelParams）
      expect(await screen.findByText(locale === "zh" ? "级别" : "Level")).toBeTruthy();
      const version = screen.getByRole("combobox", { name: m.wizard.version });
      expect(
        within(version)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual([m.wizard.versionKeep, "v3", "v2", "v1"]);
      const region = within(container.querySelector(".cb-actionrow") as HTMLElement);
      await user.click(region.getByRole("button", { name: m.wizard.next }));
      // 2. 评委与上限
      const judge = await screen.findByRole("switch", { name: m.wizard.judge });
      expect((judge as HTMLButtonElement).disabled).toBe(false);
      await user.click(judge);
      const cap = screen.getByRole("spinbutton", { name: m.wizard.tokenCap });
      // 部署默认与上限来自估算响应
      expect(
        await screen.findByText(
          fill(m.wizard.tokenCapRange, { default: "1,000,000", max: "20,000,000" }),
          { exact: false },
        ),
      ).toBeTruthy();
      await user.type(cap, "10000");
      // 改了上限会重新估算（带上 tokenCap）
      await waitFor(() =>
        expect(bodyOf(estimates(calls).at(-1))).toMatchObject({ tokenCap: 10000 }),
      );
      await user.click(region.getByRole("button", { name: m.wizard.next }));
      // 3. 估算
      const est = await screen.findByRole("region", { name: m.wizard.estimate.title });
      const value = (label: string) =>
        within(within(est).getByText(label).parentElement as HTMLElement);
      expect(value(m.wizard.estimate.cases).getByText("2")).toBeTruthy();
      expect(value(m.wizard.estimate.modelRequests).getByText("3")).toBeTruthy();
      expect(value(m.wizard.estimate.judgeRequests).getByText("3")).toBeTruthy();
      expect(value(m.wizard.estimate.tokens).getByText("12,345")).toBeTruthy();
      // 评委的份额单列（已含在总数里）
      expect(
        value(m.wizard.estimate.judgeShare).getByText(
          fill(m.wizard.estimate.judgeShareValue, { tokens: "2,345", cost: usd(0.002, locale) }),
        ),
      ).toBeTruthy();
      expect(value(m.wizard.estimate.cost).getByText(usd(0.0123, locale))).toBeTruthy();
      expect(value(m.wizard.estimate.tokenCap).getByText("10,000")).toBeTruthy();
      // 预计超过上限：提示会在上限处停下
      expect(within(est).getByText(m.wizard.estimate.overCap)).toBeTruthy();
      expect(bodyOf(estimates(calls).at(-1))).toEqual({
        mode: "step",
        candidate: { model: { provider: "model-fake", model: "fake-2" } },
        judge: true,
        tokenCap: 10000,
      });
      await user.click(region.getByRole("button", { name: m.wizard.start }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/evals/runs/er1"));
      const start = calls.find((c) => c.method === "POST" && c.url.endsWith("/s1/runs"));
      expect(bodyOf(start)).toEqual({
        mode: "step",
        candidate: { model: { provider: "model-fake", model: "fake-2" } },
        judge: true,
        tokenCap: 10000,
      });
    },
  );

  it("不填上限：确认步骤显示生效的部署默认上限；超过部署上限时不能开始", async () => {
    const calls = stubApi(routes(true));
    renderPage(<RunWizardPage />);
    const user = userEvent.setup();
    await screen.findByRole("combobox", { name: E.wizard.model });
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    const cap = await screen.findByRole("spinbutton", { name: E.wizard.tokenCap });
    await screen.findByText(
      fill(E.wizard.tokenCapRange, { default: "1,000,000", max: "20,000,000" }),
      { exact: false },
    );
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    const est = await screen.findByRole("region", { name: E.wizard.estimate.title });
    const capRow = () =>
      within(within(est).getByText(E.wizard.estimate.tokenCap).parentElement as HTMLElement);
    await waitFor(() => expect(capRow().getByText("1,000,000")).toBeTruthy());
    expect(within(est).queryByText(E.wizard.estimate.overCap)).toBeNull();
    // 回到上一步填一个超过部署上限的数：本地拦下，不发估算，不能前进
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.back }));
    const sent = estimates(calls).length;
    await user.type(await screen.findByRole("spinbutton", { name: E.wizard.tokenCap }), "30000000");
    expect(
      screen.getByText(fill(E.wizard.tokenCapTooLarge, { max: "20,000,000" }), { exact: false }),
    ).toBeTruthy();
    expect(
      (within(actionRow()).getByRole("button", { name: E.wizard.next }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(estimates(calls).length).toBe(sent);
    void cap;
  });

  it("估算按顺序生效：先发的慢响应不会覆盖后发的结果", async () => {
    let release: (r: Response) => void = () => {};
    let n = 0;
    const calls = stubApi(
      routes(true, {
        [`POST ${SETS}/s1/runs/estimate`]: (c) => {
          n++;
          if (n === 1) {
            // 第一次（不开评委）挂起，等后一次返回之后再放行
            return new Promise<Response>((resolve) => {
              release = resolve;
            }).then(() => json(200, estimated(c, { judgeRequests: 0, estimatedTokens: 111 })));
          }
          return json(200, estimated(c, { judgeRequests: 3, estimatedTokens: 999 }));
        },
      }),
    );
    renderPage(<RunWizardPage />);
    const user = userEvent.setup();
    await screen.findByRole("combobox", { name: E.wizard.model });
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    await waitFor(() => expect(estimates(calls)).toHaveLength(1));
    // 开评委：重新估算（第二次立即返回）
    await user.click(await screen.findByRole("switch", { name: E.wizard.judge }));
    await waitFor(() => expect(estimates(calls)).toHaveLength(2));
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    const est = await screen.findByRole("region", { name: E.wizard.estimate.title });
    const row = (label: string) =>
      within(within(est).getByText(label).parentElement as HTMLElement);
    await waitFor(() => expect(row(E.wizard.estimate.tokens).getByText("999")).toBeTruthy());
    // 先发的慢响应这时才回来：不覆盖
    release(new Response());
    await new Promise((r) => setTimeout(r, 50));
    expect(row(E.wizard.estimate.tokens).getByText("999")).toBeTruthy();
    expect(row(E.wizard.estimate.judgeRequests).getByText("3")).toBeTruthy();
  });

  it("读不到模型用途：显示错误，评委开关禁用", async () => {
    stubApi(
      routes(true, {
        [`GET ${ORG}/model-purposes`]: () =>
          json(503, { error: { code: "upstream_unavailable", message: "down" } }),
      }),
    );
    renderPage(<RunWizardPage />);
    const user = userEvent.setup();
    await screen.findByRole("combobox", { name: E.wizard.model });
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    const judge = await screen.findByRole("switch", { name: E.wizard.judge });
    expect(await screen.findByText(`✗ ${en.errors.upstream_unavailable}`)).toBeTruthy();
    expect((judge as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(E.wizard.judgeUnmapped)).toBeNull();
  });

  it("eval 用途未映射：评委开关禁用，并给出去配置的链接", async () => {
    stubApi(routes(false));
    renderPage(<RunWizardPage />);
    const user = userEvent.setup();
    await screen.findByRole("combobox", { name: E.wizard.model });
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    const judge = await screen.findByRole("switch", { name: E.wizard.judge });
    await waitFor(() => expect((judge as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(E.wizard.judgeUnmapped)).toBeTruthy();
    expect(screen.getByRole("link", { name: E.wizard.judgeConfigure }).getAttribute("href")).toBe(
      "/settings/models",
    );
  });

  it("覆盖指令与整轮模式；候选不合法时显示错误与明细", async () => {
    const calls = stubApi(
      routes(true, {
        [`POST ${SETS}/s1/runs/estimate`]: () =>
          json(400, {
            error: {
              code: "eval.candidate_invalid",
              message: "bad",
              details: [{ path: "candidate.agentVersion", message: "Version 9 does not exist" }],
            },
          }),
      }),
    );
    renderPage(<RunWizardPage />);
    const user = userEvent.setup();
    await screen.findByRole("combobox", { name: E.wizard.model });
    await user.click(screen.getByRole("radio", { name: new RegExp(E.mode.run) }));
    await user.click(screen.getByRole("switch", { name: E.wizard.instructionsOverride }));
    const text = screen.getByRole("textbox", { name: E.wizard.instructions });
    await user.clear(text);
    await user.type(text, "Be brief.");
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    await screen.findByRole("switch", { name: E.wizard.judge });
    await user.click(within(actionRow()).getByRole("button", { name: E.wizard.next }));
    expect(await screen.findByText(`✗ ${en.errors.eval.candidate_invalid}`)).toBeTruthy();
    expect(screen.getByText("✗ candidate.agentVersion: Version 9 does not exist")).toBeTruthy();
    expect(bodyOf(estimates(calls).at(-1))).toEqual({
      mode: "run",
      candidate: { instructions: "Be brief." },
      judge: false,
    });
    expect(
      (within(actionRow()).getByRole("button", { name: E.wizard.start }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("评测运行（DetailPage）", () => {
  const RUN = `${ORG}/eval-runs/er1`;
  /** 结果表读轻量行（`view=light`），查看器按需读单条完整行。 */
  const routes = (run: () => EvalRun, results: EvalResult[], over = {}) => ({
    [`GET ${RUN}`]: () => json(200, { run: run() }),
    [`GET ${RUN}/results`]: () => json(200, { results: results.map(light), next: null, asOf: T }),
    ...Object.fromEntries(
      results.map((r) => [`GET ${RUN}/results/${r.id}`, () => json(200, { result: r })]),
    ),
    [`GET ${SETS}/s1`]: () => json(200, { set: { ...SET, cases: CASES } }),
    ...over,
  });

  it.each(["zh", "en"] as const)(
    "结果表与 Inspector：文本差异、工具差异、评委理由；页头指标（%s）",
    async (locale) => {
      const m = msgs[locale].evals;
      stubApi(routes(() => evalRun(), [result()]));
      const { container } = renderPage(<EvalRunPage />, { locale });
      expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
      const table = await screen.findByRole("table", { name: m.run.resultsLabel });
      const row = await within(table).findByRole("row", { name: /Delete the stale item/ });
      expect(within(row).getByText(m.run.mismatch)).toBeTruthy();
      expect(within(row).getByText("60%")).toBeTruthy();
      expect(within(row).getByText(m.run.verdict.fail)).toBeTruthy();
      const metrics = container.querySelector(".cb-pageheader-metrics") as HTMLElement;
      const metric = (label: string) =>
        within(within(metrics).getByText(label).parentElement as HTMLElement);
      expect(metric(m.run.metrics.progress).getByText("2/2")).toBeTruthy();
      expect(metric(m.run.metrics.tokens).getByText("4,200 / 1,000,000")).toBeTruthy();
      expect(metric(m.run.metrics.toolMatch).getByText("50%")).toBeTruthy();
      expect(metric(m.run.metrics.judgePass).getByText("100%")).toBeTruthy();
      expect(metric(m.run.metrics.humanPass).getByText("—")).toBeTruthy();

      await userEvent.setup().click(within(row).getByText(m.run.mismatch));
      const region = await screen.findByRole("region", { name: m.run.inspector.title });
      const inspector = within(region);
      // 文本差异：lineDiff + CodeBlock（标注走 i18n）；工具差异的代码块不带标注
      const blocks = region.querySelectorAll("figure");
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.querySelector("figcaption")?.textContent).toBe(m.run.inspector.diffCaption);
      expect(blocks[0]?.querySelector("code")?.textContent).toBe(
        "- I will delete it.\n+ I will remove it.\n  Done.",
      );
      expect(blocks[1]?.querySelector("figcaption")).toBeNull();
      // 工具差异
      expect(inspector.getByText(new RegExp(m.run.inspector.toolKinds.args_changed))).toBeTruthy();
      expect(inspector.getByText(/"id":"x2"/)).toBeTruthy();
      // 评委理由
      expect(inspector.getByText("Deleted the wrong item.")).toBeTruthy();
      expect(inspector.getByText("2")).toBeTruthy();
    },
  );

  it("点标注调用 label 接口，再读运行刷新汇总", async () => {
    let labeled = false;
    let runReads = 0;
    const calls = stubApi(
      routes(
        () => {
          runReads++;
          return evalRun({
            summary: labeled ? { ...SUMMARY, humanPassRate: 1, labeled: 1 } : SUMMARY,
          });
        },
        [],
        {
          [`GET ${RUN}/results`]: () =>
            json(200, {
              results: [
                light(
                  labeled ? result({ label: "pass", labeledBy: "a1", labeledAt: T }) : result(),
                ),
              ],
              next: null,
              asOf: T,
            }),
          [`GET ${RUN}/results/res1`]: () => json(200, { result: result() }),
          [`PUT ${ORG}/eval-results/res1/label`]: () => {
            labeled = true;
            return json(200, {
              result: result({ label: "pass", labeledBy: "a1", labeledAt: T }),
            });
          },
        },
      ),
    );
    const { container } = renderPage(<EvalRunPage />);
    const table = await screen.findByRole("table", { name: E.run.resultsLabel });
    const user = userEvent.setup();
    await user.click(await within(table).findByText("Delete the stale item"));
    const inspector = within(await screen.findByRole("region", { name: E.run.inspector.title }));
    await user.type(
      inspector.getByRole("textbox", { name: new RegExp(E.run.inspector.note) }),
      "Looks right",
    );
    await user.click(inspector.getByRole("button", { name: E.run.inspector.pass }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      label: "pass",
      note: "Looks right",
    });
    const metrics = container.querySelector(".cb-pageheader-metrics") as HTMLElement;
    await waitFor(() =>
      expect(
        within(
          within(metrics).getByText(E.run.metrics.humanPass).parentElement as HTMLElement,
        ).getByText("100%"),
      ).toBeTruthy(),
    );
    expect(runReads).toBeGreaterThanOrEqual(2);
    // 表格里的标注也更新了
    expect(within(table).getByText(E.run.verdict.pass)).toBeTruthy();
    // 清除标注
    await user.click(inspector.getByRole("button", { name: E.run.inspector.clear }));
    await waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "PUT").at(-1))).toEqual({ label: null }),
    );
  });

  it("capped：提示已达到 token 上限", async () => {
    stubApi(
      routes(
        () => evalRun({ status: "capped", tokensUsed: 1200, tokenCap: 1000 }),
        [
          result(),
          result({
            id: "res2",
            caseId: "k2",
            status: "skipped",
            diff: null,
            judge: null,
            judgeStatus: "skipped",
          }),
        ],
      ),
    );
    renderPage(<EvalRunPage />);
    expect(
      await screen.findByText(fill(E.run.capped, { used: "1,200", cap: "1,000" })),
    ).toBeTruthy();
    // 已达上限有自己的符号（不是已取消的 ⊘）
    expect(screen.getAllByText(`◆ ${E.runStatus.capped}`).length).toBeGreaterThan(0);
  });

  it("failed：按错误码显示原因", async () => {
    stubApi(
      routes(
        () => evalRun({ status: "failed", error: { code: "eval.too_many_errors", message: "x" } }),
        [],
      ),
    );
    renderPage(<EvalRunPage />);
    expect(
      await screen.findByText(fill(E.run.failed, { reason: en.errors.eval.too_many_errors })),
    ).toBeTruthy();
  });

  it("执行中每 5 秒轮询；可以取消", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: EvalRun["status"] = "running";
    let runReads = 0;
    const calls = stubApi(
      routes(
        () => {
          runReads++;
          return evalRun({ status, casesDone: 1, summary: null, finishedAt: null });
        },
        [
          result({
            status: "pending",
            diff: null,
            judge: null,
            judgeStatus: "none",
            baseline: null,
            candidate: null,
          }),
        ],
        {
          [`POST ${RUN}/cancel`]: () => {
            status = "cancelled";
            return json(200, { run: evalRun({ status: "cancelled", summary: SUMMARY }) });
          },
        },
      ),
    );
    renderPage(<EvalRunPage />);
    await screen.findByRole("table", { name: E.run.resultsLabel });
    expect(screen.getByText(E.run.polling)).toBeTruthy();
    expect(runReads).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(runReads).toBe(2));
    const resultReads = calls.filter((c) => c.url.includes("/results")).length;
    expect(resultReads).toBe(2);
    // 轮询只读运行与结果，不再读评测集
    expect(calls.filter((c) => c.url === `${SETS}/s1`)).toHaveLength(1);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: E.run.cancel }));
    expect(await screen.findByText(E.run.cancelledNotice)).toBeTruthy();
    expect(screen.queryByRole("button", { name: E.run.cancel })).toBeNull();
    // 结束后不再轮询
    const reads = runReads;
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(runReads).toBe(reads);
  });

  it("运行在轮询中变成终态：再整读一次结果（不带 updatedSince），之后不再轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: EvalRun["status"] = "running";
    const calls = stubApi(
      routes(() => evalRun({ status, casesDone: 1, summary: null, finishedAt: null }), [result()]),
    );
    renderPage(<EvalRunPage />);
    await screen.findByRole("table", { name: E.run.resultsLabel });
    status = "completed";
    await act(() => vi.advanceTimersByTimeAsync(5000));
    const resultUrls = () => calls.filter((c) => c.url.includes("/results")).map((c) => c.url);
    await waitFor(() => expect(resultUrls()).toHaveLength(3));
    const [, incremental, full] = resultUrls();
    expect(incremental).toContain("updatedSince");
    expect(full).not.toContain("updatedSince");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(resultUrls()).toHaveLength(3);
  });

  it("轮询在上一次读完之后才排下一次：慢的读取不被下一拍取消；没有变化时逐步放慢", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let done = 0;
    let runReads = 0;
    let inflight = 0;
    let maxInflight = 0;
    let hold: (() => void) | null = null;
    let resultReads = 0;
    const pending = result({
      status: "pending",
      diff: null,
      judge: null,
      judgeStatus: "none",
      baseline: null,
      candidate: null,
    });
    stubApi(
      routes(
        () => {
          runReads++;
          return evalRun({ status: "running", casesDone: done, summary: null, finishedAt: null });
        },
        [],
        {
          [`GET ${RUN}/results`]: async () => {
            resultReads++;
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            // 第一次轮询的结果读取很慢（挂起到手动放行）
            if (resultReads === 2) await new Promise<void>((r) => (hold = r));
            inflight--;
            return json(200, { results: [light(pending)], next: null, asOf: T });
          },
        },
      ),
    );
    renderPage(<EvalRunPage />);
    await screen.findByRole("table", { name: E.run.resultsLabel });
    expect(runReads).toBe(1);
    done = 1;
    // 5 秒后第一次轮询：运行已读到，结果读取挂起
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(resultReads).toBe(2));
    // 挂起期间不再发新的轮询
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(runReads).toBe(2);
    expect(resultReads).toBe(2);
    // 放行：这次读取的数据照常生效（进度变化）
    (hold as unknown as () => void)();
    const metrics = document.querySelector(".cb-pageheader-metrics") as HTMLElement;
    await waitFor(() =>
      expect(
        within(
          within(metrics).getByText(E.run.metrics.progress).parentElement as HTMLElement,
        ).getByText("1/2"),
      ).toBeTruthy(),
    );
    expect(maxInflight).toBe(1);
    // 有变化：5 秒后再读
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(runReads).toBe(3));
    // 没有变化：间隔加倍到 10 秒
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(runReads).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(runReads).toBe(4));
    // 再加倍到 20 秒
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(runReads).toBe(4);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(runReads).toBe(5));
  });

  it("整轮模式的结果可以跳到评测对话的轨迹", async () => {
    stubApi(
      routes(
        () => evalRun({ mode: "run" }),
        [
          result({
            step: null,
            modelCallSeq: null,
            evalConversationId: "evc1",
            baseline: {
              toolCalls: [],
              finalContent: [{ type: "text", text: "a" }],
              stopReason: "end_turn",
            },
            candidate: {
              toolCalls: [],
              finalContent: [{ type: "text", text: "a" }],
              stopReason: "end_turn",
            },
            diff: { toolCalls: [], toolCallsMatch: true, textSimilarity: 1, stopReasonMatch: true },
          }),
        ],
      ),
    );
    renderPage(<EvalRunPage />);
    const table = await screen.findByRole("table", { name: E.run.resultsLabel });
    const row = await within(table).findByRole("row", { name: /Delete the stale item/ });
    expect(within(row).getByText(E.run.wholeRun)).toBeTruthy();
    await userEvent.setup().click(within(row).getByText(E.run.wholeRun));
    const inspector = within(await screen.findByRole("region", { name: E.run.inspector.title }));
    expect(inspector.getByText(E.run.inspector.noTextDiff)).toBeTruthy();
    expect(inspector.getByText(E.run.inspector.noToolCalls)).toBeTruthy();
    expect(
      inspector.getByRole("link", { name: E.run.inspector.evalTrajectory }).getAttribute("href"),
    ).toBe("/trajectories/evc1");
  });

  it.each(["zh", "en"] as const)("漂移原因走 i18n，不认识的显示原始码（%s）", async (locale) => {
    const m = msgs[locale].evals;
    stubApi(routes(() => evalRun(), [result({ drift: ["system_hash", "brand_new_reason"] })]));
    renderPage(<EvalRunPage />, { locale });
    const table = await screen.findByRole("table", { name: m.run.resultsLabel });
    await userEvent.setup().click(await within(table).findByText(m.run.mismatch));
    const inspector = within(await screen.findByRole("region", { name: m.run.inspector.title }));
    expect(
      await inspector.findByText(
        `${m.drift.system_hash}${m.run.inspector.driftSeparator}brand_new_reason`,
      ),
    ).toBeTruthy();
  });

  it("结果表读轻量行；轮询带上次的 asOf 只取变化并合并；查看器按需读单条完整行", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = result({
      status: "pending",
      diff: null,
      judge: null,
      judgeStatus: "none",
      baseline: null,
      candidate: null,
    });
    const other = result({ id: "res2", caseId: "k2", status: "pending", diff: null, judge: null });
    let done = false;
    const calls = stubApi(
      routes(
        () => evalRun({ status: "running", casesDone: done ? 1 : 0, summary: null }),
        [pending, other],
        {
          [`GET ${RUN}/results`]: (c: Call) =>
            c.url.includes("updatedSince=")
              ? json(200, {
                  // 只有变化的那一行
                  results: [{ ...light(result()), updatedAt: "2026-10-22T08:00:05.000Z" }],
                  next: null,
                  asOf: "2026-10-22T08:00:10.000Z",
                })
              : json(200, { results: [light(pending), light(other)], next: null, asOf: T }),
          [`GET ${RUN}/results/res1`]: () => json(200, { result: done ? result() : pending }),
        },
      ),
    );
    renderPage(<EvalRunPage />);
    const table = await screen.findByRole("table", { name: E.run.resultsLabel });
    // 首次读取是轻量视图，不带 updatedSince
    const first = calls.filter((c) => c.url.includes("/results"));
    expect(first).toHaveLength(1);
    expect(first[0]?.url).toContain("view=light");
    expect(first[0]?.url).not.toContain("updatedSince");
    // 选中才读单条
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(table).getByRole("row", { name: /Delete the stale item/ }));
    const inspector = within(await screen.findByRole("region", { name: E.run.inspector.title }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `${RUN}/results/res1`)).toHaveLength(1),
    );
    done = true;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes(`updatedSince=${encodeURIComponent(T)}`))).toBe(true),
    );
    // 变化的行合并进表格（另一行不动）；这一行的 updatedAt 变了 → 查看器重读完整行
    const row = await within(table).findByRole("row", { name: /Delete the stale item/ });
    await waitFor(() => expect(within(row).getByText(E.run.mismatch)).toBeTruthy());
    expect(within(table).getByRole("row", { name: /Summarize the doc/ })).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `${RUN}/results/res1`)).toHaveLength(2),
    );
    expect(await inspector.findByText("Deleted the wrong item.")).toBeTruthy();
    // 下一次轮询用上一次响应的 asOf
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() =>
      expect(
        calls.some((c) =>
          c.url.includes(`updatedSince=${encodeURIComponent("2026-10-22T08:00:10.000Z")}`),
        ),
      ).toBe(true),
    );
  });

  it("汇总标签页：估算里评委的份额单列", async () => {
    stubApi(routes(() => evalRun(), [result()]));
    renderPage(<EvalRunPage />);
    await screen.findByRole("table", { name: E.run.resultsLabel });
    await userEvent.setup().click(screen.getByRole("tab", { name: E.run.tabs.summary }));
    expect(
      await screen.findByText(
        fill(E.run.candidate.judgeShareValue, { tokens: "2,345", cost: usd(0.002, "en") }),
      ),
    ).toBeTruthy();
  });
});
