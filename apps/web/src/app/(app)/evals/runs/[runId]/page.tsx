import { NoAccess } from "../../../../../components/RoleGate";
import { getEvalRun, getEvalSet, listEvalResultRowsPage } from "../../../../../lib/evals";
import { read, section } from "../../../../../lib/server/page";
import { workspace } from "../../../../../lib/server/session";
import EvalRunInOrg from "./view";

/**
 * `/evals/runs/[runId]` (org admins): the run and the first page of its results (required) and its
 * set for the case titles and the path (a section: the ids show), read on the server. The polling
 * while the run is active and the pages after the first continue in the browser.
 */
export default async function EvalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const runId = decodeURIComponent((await params).runId);
  const { run } = await read(getEvalRun(ws.orgId, runId));
  const [page, set] = await Promise.all([
    read(listEvalResultRowsPage(ws.orgId, runId)),
    section(getEvalSet(ws.orgId, run.setId)),
  ]);
  return (
    <EvalRunInOrg
      orgId={ws.orgId}
      runId={runId}
      initial={{
        run,
        rows: page.rows,
        next: page.next,
        asOf: page.asOf,
        titles: Object.fromEntries((set?.set.cases ?? []).map((c) => [c.id, c.title])),
        setName: set?.set.name ?? null,
      }}
    />
  );
}
