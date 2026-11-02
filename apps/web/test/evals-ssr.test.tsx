// The eval pages render on the server (web-SSR spec §6, task 11): first paint complete without a
// browser fetch, the org-admin gate (only the session is read below it), and R5's failures.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import EvalCasePage from "../src/app/(app)/evals/[setId]/cases/[caseId]/page";
import EvalSetPage from "../src/app/(app)/evals/[setId]/page";
import RunWizardPage from "../src/app/(app)/evals/[setId]/run/page";
import NewEvalSetPage from "../src/app/(app)/evals/new/page";
import EvalsPage from "../src/app/(app)/evals/page";
import EvalRunPage from "../src/app/(app)/evals/runs/[runId]/page";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const O = "/api/v1/orgs/o1";
const SETS = `${O}/eval-sets`;
const T = "2026-10-22T08:00:00.000Z";
const E = en.evals;
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const failing = () => json(500, { error: { code: "internal", message: "x" } });
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

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
];
const SET = {
  id: "s1",
  agentId: "ag1",
  name: "Regression",
  description: "Nightly checks",
  rubric: null,
  caseCount: 1,
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
      ],
    },
  ],
};
const PURPOSES = {
  purposes: [
    {
      purpose: "eval",
      kind: "chat",
      label: { zh: "评测评委", en: "Eval judge" },
      declaredBy: "kernel",
      default: null,
      override: null,
      effective: { model: { provider: "model-fake", model: "fake-1" }, params: {} },
    },
  ],
};
const RUN = (over: Record<string, unknown> = {}) => ({
  id: "er1",
  setId: "s1",
  mode: "step",
  candidate: { model: { provider: "model-fake", model: "fake-1" } },
  judge: false,
  status: "completed",
  tokenCap: 1_000_000,
  tokensUsed: 4200,
  casesTotal: 1,
  casesDone: 1,
  estimate: {
    cases: 1,
    modelRequests: 2,
    judgeRequests: 0,
    estimatedTokens: 100,
    estimatedCost: null,
    currency: "USD",
  },
  summary: null,
  error: null,
  createdAt: T,
  finishedAt: T,
  ...over,
});
const ROW = (id: string, caseId = "k1") => ({
  id,
  caseId,
  step: 0,
  modelCallSeq: 4,
  status: "done",
  judgeStatus: "skipped",
  verdict: null,
  label: null,
  driftCount: 0,
  errorCode: null,
  toolCallsMatch: true,
  textSimilarity: 0.9,
  updatedAt: T,
});
const TRAJECTORY_RUN = {
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

const ROUTES: Routes = {
  [`GET ${O}/members`]: () => json(200, { members: [] }),
  [`GET ${SETS}`]: () => json(200, { sets: [SET] }),
  [`GET ${O}/agents`]: () => json(200, { agents: [AGENT] }),
  [`GET ${O}/agents/ag1`]: () => json(200, { agent: AGENT }),
  [`GET ${SETS}/s1`]: () => json(200, { set: { ...SET, cases: CASES } }),
  [`GET ${SETS}/s1/runs`]: () => json(200, { runs: [RUN()] }),
  [`GET ${O}/models`]: () => json(200, MODELS),
  [`GET ${O}/model-purposes`]: () => json(200, PURPOSES),
  [`GET ${SETS}/s1/cases/k1`]: () =>
    json(200, { case: CASES[0], trajectory: [TRAJECTORY_RUN], currency: "USD" }),
  [`GET ${O}/eval-runs/er1`]: () => json(200, { run: RUN() }),
  [`GET ${O}/eval-runs/er1/results`]: () =>
    json(200, { results: [ROW("res1"), ROW("res2")], next: null, asOf: T }),
};

const setPage = () => EvalSetPage({ params: Promise.resolve({ setId: "s1" }) });
const wizardPage = () => RunWizardPage({ params: Promise.resolve({ setId: "s1" }) });
const casePage = () => EvalCasePage({ params: Promise.resolve({ setId: "s1", caseId: "k1" }) });
const runPage = () => EvalRunPage({ params: Promise.resolve({ runId: "er1" }) });

beforeEach(() => resetNavigation("/evals"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("first paint comes from the server (no browser fetch)", () => {
  it("/evals: the sets with their agent's name", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => EvalsPage(), ROUTES);
    const list = screen.getByRole("list", { name: E.tabs.sets });
    expect(within(list).getByText(/Helper · .*1/)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/evals: agents the kernel fails only cost the names (the id shows)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => EvalsPage(), { ...ROUTES, [`GET ${O}/agents`]: failing });
    expect(screen.getByText(/ag1 · .*1/)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/evals/new: the agents to choose from", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => NewEvalSetPage(), ROUTES);
    const agent = screen.getByRole("combobox", { name: E.form.agentLabel }) as HTMLSelectElement;
    expect(agent.value).toBe("ag1");
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]: the cases, the inspector's agent and the runs tab", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(setPage, ROUTES);
    const cases = screen.getByRole("table", { name: E.set.casesLabel });
    expect(within(cases).getByText("Delete the stale item")).toBeTruthy();
    expect(screen.getByText("Helper")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }));
    const runs = screen.getByRole("table", { name: E.set.runsLabel });
    expect(within(runs).getByText("1/1")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]: runs the kernel fails are the tab's own error, retried on the server", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(setPage, {
      ...ROUTES,
      [`GET ${SETS}/s1/runs`]: failing,
      [`GET ${O}/agents/ag1`]: failing,
    });
    // the agent's name falls back to its id
    expect(screen.getByText("ag1")).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }));
    await u.click(screen.getByRole("button", { name: en.common.retry }));
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() => expect(calls.filter((c) => c.url === `${SETS}/s1/runs`).length).toBe(2));
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]: an unknown set is not found", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(setPage, {
        ...ROUTES,
        [`GET ${SETS}/s1`]: () => json(404, { error: { code: "eval.not_found", message: "x" } }),
      }),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("/evals/[setId]/run: the agent's versions and the models", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(wizardPage, ROUTES);
    const model = screen.getByRole("combobox", { name: E.wizard.model });
    expect(within(model).getByRole("option", { name: "model-fake/fake-1" })).toBeTruthy();
    const version = screen.getByRole("combobox", { name: E.wizard.version });
    expect(within(version).getAllByRole("option").length).toBe(4);
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]/cases/[caseId]: the snapshot trajectory with the set's name", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(casePage, ROUTES);
    const tree = screen.getByRole("tree", { name: en.trajectories.detail.waterfall });
    expect(within(tree).getByText("v2")).toBeTruthy();
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: SET.name }).getAttribute("href")).toBe(
      "/evals/s1",
    );
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]/cases/[caseId]: a set the kernel fails shows its id in the path", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(casePage, { ...ROUTES, [`GET ${SETS}/s1`]: failing });
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: "s1" })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/evals/runs/[runId]: the run, its first page of results and the set's name", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(runPage, ROUTES);
    const table = screen.getByRole("table", { name: E.run.resultsLabel });
    expect(within(table).getAllByText("Delete the stale item").length).toBe(2);
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: SET.name })).toBeTruthy();
    // one page of 200 on the server
    expect(calls.filter((c) => c.url.includes("/results")).map((c) => c.url)).toEqual([
      `${O}/eval-runs/er1/results?view=light&limit=200`,
    ]);
    expect(screen.queryByRole("button", { name: E.run.loadMore })).toBeNull();
    expect(browser).toEqual([]);
  });

  it("/evals/runs/[runId]: results past the first page load in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/eval-runs/er1/results`]: () =>
        json(200, { results: [ROW("res3")], next: null, asOf: T }),
    });
    await renderRoute(runPage, {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1/results`]: () =>
        json(200, { results: [ROW("res1"), ROW("res2")], next: "res2", asOf: T }),
    });
    expect(browser).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: E.run.loadMore }));
    const table = screen.getByRole("table", { name: E.run.resultsLabel });
    await waitFor(() => expect(within(table).getAllByText("Delete the stale item").length).toBe(3));
    expect(browser.map((c) => c.url)).toEqual([
      `${O}/eval-runs/er1/results?view=light&limit=200&after=res2`,
    ]);
    expect(screen.queryByRole("button", { name: E.run.loadMore })).toBeNull();
  });

  it("/evals/runs/[runId]: an active run polls only after first paint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const browser = stubApi({
      [`GET ${O}/eval-runs/er1`]: () => json(200, { run: RUN() }),
      [`GET ${O}/eval-runs/er1/results`]: () => json(200, { results: [], next: null, asOf: T }),
    });
    await renderRoute(runPage, {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1`]: () =>
        json(200, { run: RUN({ status: "running", casesDone: 0 }) }),
    });
    expect(screen.getByText(E.run.polling)).toBeTruthy();
    expect(browser).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(browser.some((c) => c.url === `${O}/eval-runs/er1`)).toBe(true));
  });

  it("/evals/runs/[runId]: a set the kernel fails shows its id in the path", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(runPage, { ...ROUTES, [`GET ${SETS}/s1`]: failing });
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: "s1" })).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

const GATES: [string, () => Promise<ReactNode>][] = [
  ["/evals", () => EvalsPage()],
  ["/evals/new", () => NewEvalSetPage()],
  ["/evals/s1", setPage],
  ["/evals/s1/run", wizardPage],
  ["/evals/s1/cases/k1", casePage],
  ["/evals/runs/er1", runPage],
];

describe("the gates (org admins)", () => {
  it.each(GATES)(
    "%s: a member gets no access and nothing read; no org renders nothing; setup goes home",
    async (_p, page) => {
      const denied = await renderRoute(page, ROUTES, { me: as("member") });
      expect(new Set(denied.calls.map((c) => c.url))).toEqual(
        new Set(["/api/v1/me", `${O}/readiness`]),
      );
      expect(noAccess()).toBe(true);
      cleanup();
      const none = await renderRoute(page, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      cleanup();
      await expect(renderRoute(page, ROUTES, { readiness: NOT_READY })).rejects.toThrow(
        "REDIRECT /",
      );
    },
  );
});
