// The eval pages read from the query cache the layout prefetched (web query cache spec §3): first
// paint complete without a browser read, the loading state on an empty cache, the org-admin gate
// (only the session is read below it), R5's failures and the mutations' invalidations.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { fieldOptionLabels } from "./support/select";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";
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
  account: { ...ME.account, isSuperAdmin: false },
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
  [`GET ${O}/agents/ag1/versions`]: () =>
    json(200, {
      versions: [{ version: 3, createdBy: "u1", createdAt: "2026-11-07T13:30:00.000Z" }],
    }),
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

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** A client navigation to `path` with an empty cache whose `held` read answers on `release()`. */
async function renderHeld(path: string, held: string, routes: Routes = ROUTES) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  const r = await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { ...r, release: () => act(async () => release()) };
}

beforeEach(() => resetNavigation("/evals"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("first paint comes from the hydrated cache (no browser read)", () => {
  it("/evals: a first render from the hydrated cache makes no browser read (the sets with their agent's name)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals", ROUTES);
    const list = screen.getByRole("list", { name: E.tabs.sets });
    expect(within(list).getByText(/Helper · .*1/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals: agents the kernel fails only cost the names (the id shows; not read again on mount)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals", { ...ROUTES, [`GET ${O}/agents`]: failing });
    expect(screen.getByText(/ag1 · .*1/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/new: a first render from the hydrated cache makes no browser read (the agents to choose from)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/new", ROUTES);
    const agent = screen.getByRole("combobox", { name: E.form.agentLabel }) as HTMLButtonElement;
    expect(agent.value).toBe("ag1");
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/evals", `GET ${SETS}`, "ListPage", "Regression"],
    ["/evals/new", `GET ${O}/agents`, "FormPage", "Helper"],
  ])(
    "%s: an empty cache shows the template's loading state, then the data",
    async (path, held, name, text) => {
      const { release } = await renderHeld(path, held);
      await vi.waitFor(() => {
        if (template(name) === null) throw new Error("no page");
      });
      expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
      expect(screen.queryByText(text)).toBeNull();
      await release();
      expect(await screen.findByText(text)).toBeTruthy();
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    },
  );

  it("/evals/new: creating a set invalidates the sets list", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`POST ${SETS}`]: () => json(201, { set: { ...SET, id: "s2" } }),
    });
    const { client } = await renderRouteWithCache("/evals/new", ROUTES);
    client.setQueryData(["org", "o1", "evalSets"], { sets: [SET] });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: new RegExp(E.form.nameLabel) }), "Nightly");
    await user.click(screen.getByRole("button", { name: E.form.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/evals/s2"));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${SETS}`]);
    expect(client.getQueryState(["org", "o1", "evalSets"])?.isInvalidated).toBe(true);
  });

  it("/evals/[setId]: a first render from the hydrated cache makes no browser read (the cases, the inspector's agent and the runs tab)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/s1", ROUTES);
    const cases = screen.getByRole("table", { name: E.set.casesLabel });
    expect(within(cases).getByText("Delete the stale item")).toBeTruthy();
    expect(screen.getByText("Helper")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }));
    const runs = screen.getByRole("table", { name: E.set.runsLabel });
    expect(within(runs).getByText("1/1")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]: runs the kernel fails are the tab's own error, retried in the browser", async () => {
    const browser = stubApi(ROUTES);
    await renderRouteWithCache("/evals/s1", {
      ...ROUTES,
      [`GET ${SETS}/s1/runs`]: failing,
      [`GET ${O}/agents/ag1`]: failing,
    });
    // the agent's name falls back to its id
    expect(screen.getByText("ag1")).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }));
    await settle();
    // hydrated errors are not read again on mount
    expect(browser).toEqual([]);
    await u.click(screen.getByRole("button", { name: en.common.retry }));
    const runs = await screen.findByRole("table", { name: E.set.runsLabel });
    await waitFor(() => expect(within(runs).getByText("1/1")).toBeTruthy());
    expect(browser.map((c) => c.url)).toEqual([`${SETS}/s1/runs`]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("/evals/[setId]: an unknown set is the not-found state in the shell", async () => {
    await renderRouteWithCache("/evals/s1", {
      ...ROUTES,
      [`GET ${SETS}/s1`]: () => json(404, { error: { code: "eval.not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("/evals/[setId]: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/evals/s1", `GET ${SETS}/s1`);
    await vi.waitFor(() => {
      if (template("DetailPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Delete the stale item")).toBeNull();
    // the loaded shape: the head's three action slots, the facts block, the cases table's header
    const page = template("DetailPage") as HTMLElement;
    expect(page.querySelectorAll('[data-part="page-header-action-slots"] [data-box]')).toHaveLength(
      3,
    );
    expect(page.querySelector('[data-empty="loading"]')).not.toBeNull();
    for (const h of Object.values(E.set.caseColumns))
      expect(within(page).getByText(h)).toBeTruthy();
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(page.querySelector(".cb-body-inspector")).toBeNull();
    expect(
      page.querySelectorAll('[data-part="detail-facts"] [data-part="key-value-row"]'),
    ).toHaveLength(3);
    // the description's line is held over the rows, as the loaded facts put it first
    expect(page.querySelector('[data-part="detail-facts"] [data-size="prose"]')).not.toBeNull();
    await release();
    expect(await screen.findByText("Delete the stale item")).toBeTruthy();
    // loaded, the facts block keeps its three rows (agent, created, the default rubric)
    expect(
      document.querySelectorAll('[data-part="detail-facts"] [data-part="key-value-row"]'),
    ).toHaveLength(3);
    // the agent is read once the set named it
    expect(await screen.findByText("Helper")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/evals/[setId]: removing a case invalidates the set and the sets list", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`DELETE ${SETS}/s1/cases/k1`]: () => new Response(null, { status: 204 }),
    });
    const { client } = await renderRouteWithCache("/evals/s1", ROUTES);
    client.setQueryData(["org", "o1", "evalSets"], { sets: [SET] });
    const u = userEvent.setup();
    const row = within(screen.getByRole("table", { name: E.set.casesLabel })).getByRole("row", {
      name: /Delete the stale item/,
    });
    await u.click(within(row).getByRole("button", { name: /./ }));
    await u.click(await screen.findByRole("menuitem", { name: E.set.removeCase }));
    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `DELETE ${SETS}/s1/cases/k1`,
        `GET ${SETS}/s1`,
      ]),
    );
    expect(client.getQueryState(["org", "o1", "evalSets"])?.isInvalidated).toBe(true);
  });

  it("/evals/[setId]: deleting the set invalidates the sets list and forgets the set and its runs once the page is left", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`DELETE ${SETS}/s1`]: () => new Response(null, { status: 204 }),
    });
    const { client, unmount } = await renderRouteWithCache("/evals/s1", ROUTES);
    client.setQueryData(["org", "o1", "evalSets"], { sets: [SET] });
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: E.set.more }));
    await u.click(await screen.findByRole("menuitem", { name: E.set.delete }));
    const dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByRole("textbox"), SET.name);
    await u.click(within(dialog).getByRole("button", { name: E.set.delete }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/evals"));
    expect(client.getQueryState(["org", "o1", "evalSets"])?.isInvalidated).toBe(true);
    // still cached while the page shows (no read, no not-found flash before the navigation) ...
    expect(client.getQueryData(["org", "o1", "evalSet", "s1"])).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1, name: en.notFound.title })).toBeNull();
    // ... and gone once the page is left
    unmount();
    expect(client.getQueryState(["org", "o1", "evalSet", "s1"])).toBeUndefined();
    expect(client.getQueryState(["org", "o1", "evalRuns", "s1"])).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${SETS}/s1`]);
  });

  it("/evals/[setId]/run: a first render from the hydrated cache makes no browser read (the agent's versions and the models)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/s1/run", ROUTES);
    const model = screen.getByRole("combobox", { name: E.wizard.model });
    expect(fieldOptionLabels(model)).toContain("model-fake / Fake 1");
    const version = screen.getByRole("combobox", { name: E.wizard.version });
    expect(fieldOptionLabels(version)).toHaveLength(4);
    // the versions' saved times come from the hydrated cache too
    expect(fieldOptionLabels(version)[1]).toContain(`v3 · ${E.wizard.versionCurrent} · `);
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]/run: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/evals/s1/run", `GET ${O}/agents/ag1`);
    await vi.waitFor(() => {
      if (template("WizardPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    // step 0's two sections with their real titles: the mode's two radio cards, then the
    // candidate's two selects and the instruction switch; one busy announcement
    const page = template("WizardPage") as HTMLElement;
    expect(page.querySelectorAll('[data-part="form-section"]')).toHaveLength(2);
    expect(within(page).getByRole("heading", { name: E.wizard.mode })).toBeTruthy();
    expect(within(page).getByRole("heading", { name: E.wizard.candidate })).toBeTruthy();
    expect(within(page).getByText(E.wizard.candidateHint)).toBeTruthy();
    expect(page.querySelectorAll('[data-part="loading-radio"]')).toHaveLength(2);
    expect(page.querySelectorAll('[data-part="loading-field"]')).toHaveLength(2);
    expect(page.querySelectorAll('[data-part="loading-switch"]')).toHaveLength(1);
    expect(page.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: E.wizard.model })).toBeNull();
    await release();
    expect(await screen.findByRole("combobox", { name: E.wizard.model })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/evals/[setId]/run: starting a run invalidates the set's runs", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`POST ${SETS}/s1/runs/estimate`]: () =>
        json(200, {
          estimate: RUN().estimate,
          defaultTokenCap: 1_000_000,
          maxTokenCap: 20_000_000,
          effectiveTokenCap: 1_000_000,
        }),
      [`POST ${SETS}/s1/runs`]: () => json(201, { run: RUN({ status: "queued" }) }),
    });
    const { client } = await renderRouteWithCache("/evals/s1/run", ROUTES);
    client.setQueryData(["org", "o1", "evalRuns", "s1"], { runs: [] });
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: E.wizard.next }));
    await u.click(screen.getByRole("button", { name: E.wizard.next }));
    const start = screen.getByRole("button", { name: E.wizard.start });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await u.click(start);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/evals/runs/er1"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${SETS}/s1/runs/estimate`,
      `${SETS}/s1/runs`,
    ]);
    expect(client.getQueryState(["org", "o1", "evalRuns", "s1"])?.isInvalidated).toBe(true);
  });

  it("/evals/[setId]/cases/[caseId]: a first render from the hydrated cache makes no browser read (the snapshot trajectory with the set's name)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/s1/cases/k1", ROUTES);
    const tree = screen.getByRole("tree", { name: en.trajectories.detail.waterfall });
    expect(within(tree).getByText("v2")).toBeTruthy();
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: SET.name }).getAttribute("href")).toBe(
      "/evals/s1",
    );
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]/cases/[caseId]: a set the kernel fails shows its id in the path", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/s1/cases/k1", { ...ROUTES, [`GET ${SETS}/s1`]: failing });
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: "s1" })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/[setId]/cases/[caseId]: members the kernel refuses only cost the names; another failure is the error state", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/s1/cases/k1", {
      ...ROUTES,
      [`GET ${O}/members`]: () => json(403, { error: { code: "forbidden", message: "x" } }),
    });
    expect(screen.getByRole("tree", { name: en.trajectories.detail.waterfall })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    cleanup();
    stubApi(ROUTES);
    await renderRouteWithCache("/evals/s1/cases/k1", { ...ROUTES, [`GET ${O}/members`]: failing });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    await userEvent.setup().click(screen.getByRole("button", { name: en.errors.page.retry }));
    expect(
      await screen.findByRole("tree", { name: en.trajectories.detail.waterfall }),
    ).toBeTruthy();
  });

  it("/evals/[setId]/cases/[caseId]: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/evals/s1/cases/k1", `GET ${SETS}/s1/cases/k1`);
    await vi.waitFor(() => {
      if (template("TracePage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("tree", { name: en.trajectories.detail.waterfall })).toBeNull();
    await release();
    expect(
      await screen.findByRole("tree", { name: en.trajectories.detail.waterfall }),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/evals/runs/[runId]: a first render from the hydrated cache makes no browser read (the run, its first page of results and the set's name)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/evals/runs/er1", ROUTES);
    const table = screen.getByRole("table", { name: E.run.resultsLabel });
    expect(within(table).getAllByText("Delete the stale item").length).toBe(2);
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: SET.name })).toBeTruthy();
    // one page of 200 on the server
    expect(calls.filter((c) => c.url.includes("/results")).map((c) => c.url)).toEqual([
      `${O}/eval-runs/er1/results?view=light&limit=200`,
    ]);
    expect(screen.queryByRole("button", { name: E.run.loadMore })).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/evals/runs/[runId]: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/evals/runs/er1", `GET ${O}/eval-runs/er1`);
    await vi.waitFor(() => {
      if (template("DetailPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    // the loaded shape: five stat slots under the head and the results table's header, in one
    // column (no inspector, no facts block: nothing is open yet)
    const page = template("DetailPage") as HTMLElement;
    expect(page.querySelectorAll('[data-part="stat-card"]')).toHaveLength(5);
    expect(page.querySelector('[data-empty="loading"]')).not.toBeNull();
    for (const h of Object.values(E.run.columns)) expect(within(page).getByText(h)).toBeTruthy();
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(page.querySelector(".cb-body-inspector")).toBeNull();
    expect(page.querySelector('[data-part="detail-facts"]')).toBeNull();
    expect(screen.queryByRole("table", { name: E.run.resultsLabel })).toBeNull();
    await release();
    const table = await screen.findByRole("table", { name: E.run.resultsLabel });
    // the set is read once the run named it: the case titles
    await waitFor(() => expect(within(table).getAllByText("Delete the stale item").length).toBe(2));
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/evals/runs/[runId]: an unknown run is the not-found state in the shell", async () => {
    await renderRouteWithCache("/evals/runs/er1", {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1`]: () =>
        json(404, { error: { code: "eval.not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("/evals/runs/[runId]: results past the first page load in the browser", async () => {
    const browser = stubApi({
      [`GET ${O}/eval-runs/er1/results`]: () =>
        json(200, { results: [ROW("res3")], next: null, asOf: T }),
    });
    await renderRouteWithCache("/evals/runs/er1", {
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

  it("/evals/runs/[runId]: a Load more that lands while a poll is in flight survives the poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const browser = stubApi({
      [`GET ${O}/eval-runs/er1`]: () =>
        json(200, { run: RUN({ status: "running", casesDone: 0 }) }),
      [`GET ${O}/eval-runs/er1/results`]: async (c) => {
        if (c.url.includes("after=")) {
          return json(200, { results: [ROW("res3")], next: "res3", asOf: T });
        }
        await held;
        return json(200, { results: [], next: null, asOf: "2026-10-22T08:00:05.000Z" });
      },
    });
    await renderRouteWithCache("/evals/runs/er1", {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1`]: () =>
        json(200, { run: RUN({ status: "running", casesDone: 0 }) }),
      [`GET ${O}/eval-runs/er1/results`]: () =>
        json(200, { results: [ROW("res1"), ROW("res2")], next: "res2", asOf: T }),
    });
    // the poll starts and its results read is held
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(browser.some((c) => c.url.includes("updatedSince="))).toBe(true));
    // Load more lands first
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole("button", { name: E.run.loadMore }));
    const table = screen.getByRole("table", { name: E.run.resultsLabel });
    await waitFor(() => expect(within(table).getAllByText("Delete the stale item").length).toBe(3));
    // then the poll answers: the loaded page and its newer cursor stay
    await act(async () => release());
    await waitFor(() =>
      expect(browser.filter((c) => c.url.includes("updatedSince=")).length).toBe(1),
    );
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(within(table).getAllByText("Delete the stale item").length).toBe(3);
    expect(screen.getByRole("button", { name: E.run.loadMore })).toBeTruthy();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole("button", { name: E.run.loadMore }));
    await waitFor(() => expect(browser.some((c) => c.url.includes("after=res3"))).toBe(true));
  });

  it("/evals/runs/[runId]: an active run polls only after first paint (refetchInterval)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const browser = stubApi({
      [`GET ${O}/eval-runs/er1`]: () => json(200, { run: RUN() }),
      [`GET ${O}/eval-runs/er1/results`]: () => json(200, { results: [], next: null, asOf: T }),
    });
    await renderRouteWithCache("/evals/runs/er1", {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1`]: () =>
        json(200, { run: RUN({ status: "running", casesDone: 0 }) }),
    });
    expect(screen.getByText(E.run.polling)).toBeTruthy();
    expect(browser).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(browser.some((c) => c.url === `${O}/eval-runs/er1`)).toBe(true));
    // the poll reads only the rows changed since the server's read
    expect(browser.some((c) => c.url.includes(`updatedSince=${encodeURIComponent(T)}`))).toBe(true);
  });

  it("/evals/runs/[runId]: cancelling invalidates the run (read again) and the set's runs", async () => {
    let status = "running";
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/eval-runs/er1`]: () => json(200, { run: RUN({ status, casesDone: 0 }) }),
    };
    const calls = stubApi({
      ...routes,
      [`POST ${O}/eval-runs/er1/cancel`]: () => {
        status = "cancelled";
        return json(200, { run: RUN({ status }) });
      },
    });
    const { client } = await renderRouteWithCache("/evals/runs/er1", routes);
    client.setQueryData(["org", "o1", "evalRuns", "s1"], { runs: [] });
    await userEvent.setup().click(screen.getByRole("button", { name: E.run.cancel }));
    expect(await screen.findByText(E.run.cancelledNotice)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`).slice(0, 2)).toEqual([
      `POST ${O}/eval-runs/er1/cancel`,
      `GET ${O}/eval-runs/er1`,
    ]);
    expect(client.getQueryState(["org", "o1", "evalRuns", "s1"])?.isInvalidated).toBe(true);
  });

  it("/evals/runs/[runId]: a set the kernel fails shows its id in the path", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/evals/runs/er1", { ...ROUTES, [`GET ${SETS}/s1`]: failing });
    const path = screen.getByRole("navigation", { name: "Path" });
    expect(within(path).getByRole("link", { name: "s1" })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });
});

/** The pages that read through the query cache. */
const ROUTE_GATES = ["/evals", "/evals/new", "/evals/s1", "/evals/s1/run", "/evals/s1/cases/k1"];

describe("the gates (org admins)", () => {
  it.each(ROUTE_GATES)(
    "%s: a member gets no access and nothing read; no org renders nothing; setup goes home",
    async (path) => {
      const denied = await renderRouteWithCache(path, ROUTES, { me: as("member") });
      expect(new Set(denied.calls.map((c) => c.url))).toEqual(
        new Set(["/api/v1/me", `${O}/readiness`]),
      );
      expect(noAccess()).toBe(true);
      cleanup();
      const none = await renderRouteWithCache(path, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(document.body.textContent).toBe("");
      cleanup();
      expectNoFirstPaintFetch();
      await renderRouteWithCache(path, ROUTES, { readiness: NOT_READY });
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    },
  );
});
