"use client";

import { AgentForm } from "../../../../../components/AgentForm";
import { OrgGate } from "../../../../../components/OrgGate";
import { useRouter } from "../../../../../i18n/navigation";

/** `/[locale]/agents/new`：新建 agent，保存后回到列表。 */
export default function NewAgentPage() {
  const router = useRouter();
  return (
    <OrgGate>
      {(orgId) => <AgentForm orgId={orgId} onDone={() => router.push("/agents")} />}
    </OrgGate>
  );
}
