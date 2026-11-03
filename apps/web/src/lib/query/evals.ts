import type { QueryClient } from "@tanstack/react-query";
import {
  type EvalResultRow,
  type EvalRun,
  estimateEvalRun,
  getEvalCase,
  getEvalResult,
  getEvalRun,
  getEvalSet,
  listEvalResultRows,
  listEvalResultRowsPage,
  listEvalRuns,
  listEvalSets,
  mergeResultRows,
  runActive,
} from "../evals";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's eval sets (`{ sets }`). */
export const evalSetsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).evalSets(),
    fn: () => listEvalSets(orgId),
    freshness: "orgConfig",
  });

/** One eval set with its cases (a 404 is the page's not-found). */
export const evalSetQuery = (orgId: string, setId: string) =>
  defineQuery({
    key: keys.org(orgId).evalSet(setId),
    fn: () => getEvalSet(orgId, setId).then((r) => r.set),
    freshness: "orgConfig",
  });

/** An eval set's runs (`{ runs }`): they move on their own. */
export const evalRunsQuery = (orgId: string, setId: string) =>
  defineQuery({
    key: keys.org(orgId).evalRuns(setId),
    fn: () => listEvalRuns(orgId, setId),
    freshness: "live",
  });

/** One eval case's snapshot trajectory (each read is audited by the kernel). */
export const evalCaseQuery = (orgId: string, setId: string, caseId: string) =>
  defineQuery({
    key: keys.org(orgId).evalCase(setId, caseId),
    fn: () => getEvalCase(orgId, setId, caseId),
    freshness: "orgConfig",
  });

/** The input an estimate is read for (a run's input and its optional token cap). */
export type EstimateBody = Parameters<typeof estimateEvalRun>[2];

/** The estimate of a run's input (a POST that reads: nothing changes on the kernel). */
export const evalEstimateQuery = (orgId: string, setId: string, body: EstimateBody) =>
  defineQuery({
    key: keys.org(orgId).evalEstimate(setId, JSON.stringify(body)),
    fn: () => estimateEvalRun(orgId, setId, body),
    freshness: "live",
  });

/** An eval run as its page shows it: the run and the light result rows read so far. */
export interface EvalRunState {
  run: EvalRun;
  /** The light rows loaded so far (id order). */
  rows: EvalResultRow[];
  /** The cursor of the next page of results (`null`: every page is loaded). */
  next: string | null;
  /** The next poll's `updatedSince` (null when the kernel gave none: every read is complete). */
  asOf: string | null;
  /** Polls in a row that changed nothing (the polling slows down while it grows). */
  quiet: number;
}

/** The run and the first page of its results. */
async function firstRead(orgId: string, runId: string): Promise<EvalRunState> {
  const [{ run }, page] = await Promise.all([
    getEvalRun(orgId, runId),
    listEvalResultRowsPage(orgId, runId),
  ]);
  return { run, rows: page.rows, next: page.next, asOf: page.asOf, quiet: 0 };
}

/**
 * One poll on top of `prev`: the run, and the result rows changed since the last read (merged by
 * id). When the run just ended every light row is read once more (an incremental read can miss the
 * last rows written at the same instant as the previous `asOf`).
 */
async function poll(orgId: string, runId: string, prev: EvalRunState): Promise<EvalRunState> {
  const since = prev.asOf ?? undefined;
  const [{ run }, page] = await Promise.all([
    getEvalRun(orgId, runId),
    listEvalResultRows(orgId, runId, since),
  ]);
  const complete =
    since === undefined
      ? page
      : runActive(prev.run.status) && !runActive(run.status)
        ? await listEvalResultRows(orgId, runId)
        : null;
  const changed =
    prev.run.status !== run.status ||
    prev.run.casesDone !== run.casesDone ||
    prev.run.tokensUsed !== run.tokensUsed;
  return {
    run,
    rows: complete !== null ? complete.rows : mergeResultRows(prev.rows, page.rows),
    next: complete !== null ? null : prev.next,
    asOf: (complete ?? page).asOf ?? prev.asOf,
    quiet: changed ? 0 : prev.quiet + 1,
  };
}

/**
 * An eval run and its result rows (a 404 is the page's not-found). The first read is the run and
 * the first page of results; with `qc` (the browser's client) a read on top of cached rows is a
 * poll: the run and only the rows changed since (`updatedSince`), merged. The page polls it with
 * `refetchInterval` while the run is active ({@link evalRunPollMs}).
 */
export const evalRunQuery = (orgId: string, runId: string, qc?: QueryClient) => {
  const key = keys.org(orgId).evalRun(runId);
  return defineQuery({
    key,
    fn: () => {
      const prev = qc?.getQueryData<EvalRunState>(key);
      return prev === undefined ? firstRead(orgId, runId) : poll(orgId, runId, prev);
    },
    freshness: "live",
  });
};

/** How often an active run is polled: 5 s after a change, doubling up to 30 s while quiet. */
export const evalRunPollMs = (state: EvalRunState | undefined): number | false =>
  state === undefined || !runActive(state.run.status)
    ? false
    : Math.min(5_000 * 2 ** state.quiet, 30_000);

/** The page of result rows after `after` ("Load more"). */
export const evalResultPageQuery = (orgId: string, runId: string, after: string) =>
  defineQuery({
    key: keys.org(orgId).evalResultPage(runId, after),
    fn: () => listEvalResultRowsPage(orgId, runId, { after }),
    freshness: "live",
  });

/** One result's full row as of its light row's `updatedAt` (a newer one is another read). */
export const evalResultQuery = (
  orgId: string,
  runId: string,
  resultId: string,
  updatedAt: string,
) =>
  defineQuery({
    key: keys.org(orgId).evalResult(runId, resultId, updatedAt),
    fn: () => getEvalResult(orgId, runId, resultId).then((r) => r.result),
    freshness: "live",
  });
