import { NoAccess } from "../../../../../components/NoAccess";
import { getAgent, listModels } from "../../../../../lib/agents";
import { getEvalSet, listModelPurposes } from "../../../../../lib/evals";
import { read, section } from "../../../../../lib/server/page";
import { workspace } from "../../../../../lib/server/session";
import RunWizard from "./view";

/**
 * `/evals/[setId]/run` (org admins): the set, its agent and the models (required) and the model
 * purposes for the judge switch (a section: the judge step draws the error), read on the server.
 */
export default async function RunWizardPage({ params }: { params: Promise<{ setId: string }> }) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const setId = decodeURIComponent((await params).setId);
  const { set } = await read(getEvalSet(ws.orgId, setId));
  const [{ agent }, { providers }, purposes] = await Promise.all([
    read(getAgent(ws.orgId, set.agentId)),
    read(listModels(ws.orgId)),
    section(listModelPurposes(ws.orgId)),
  ]);
  return (
    <RunWizard
      orgId={ws.orgId}
      set={set}
      agent={agent}
      providers={providers}
      purposes={purposes?.purposes ?? null}
    />
  );
}
