import { NoAccess } from "../../../../../../components/RoleGate";
import { getEvalCase, getEvalSet } from "../../../../../../lib/evals";
import { read, section } from "../../../../../../lib/server/page";
import { workspace } from "../../../../../../lib/server/session";
import EvalCaseView from "./view";

/**
 * `/evals/[setId]/cases/[caseId]` (org admins): the case's snapshot trajectory (required; read once
 * per view, the kernel audits it) and the set's name for the path (a section), read on the server.
 */
export default async function EvalCasePage({
  params,
}: {
  params: Promise<{ setId: string; caseId: string }>;
}) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const p = await params;
  const setId = decodeURIComponent(p.setId);
  const caseId = decodeURIComponent(p.caseId);
  const [detail, set] = await Promise.all([
    read(getEvalCase(ws.orgId, setId, caseId)),
    section(getEvalSet(ws.orgId, setId)),
  ]);
  return <EvalCaseView setId={setId} detail={detail} setName={set?.set.name ?? null} />;
}
