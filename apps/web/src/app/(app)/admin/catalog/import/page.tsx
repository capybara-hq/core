import { NoAccess } from "../../../../../components/RoleGate";
import { ApiClientError } from "../../../../../lib/api";
import { getStagedImport } from "../../../../../lib/catalog";
import { isKernelUnavailable, isSignedOut, read } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import PluginImportWizard, { type StagedImport } from "./view";

/**
 * `/admin/catalog/import` (enterprise admins): `?staging=<id>` names a staged import (opened from
 * the marketplace entries, or a reload), read on the server. A staged import the kernel refuses
 * (expired, already confirmed) is shown as the page's own problem, never a not-found page.
 */
export default async function PluginImportPage({
  searchParams,
}: {
  searchParams: Promise<{ staging?: string | string[] }>;
}) {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const { staging } = await searchParams;
  if (typeof staging !== "string" || staging === "") return <PluginImportWizard initial={null} />;
  const staged: StagedImport = await read(
    getStagedImport(staging).then(
      (prepared): StagedImport => prepared,
      (e: unknown): StagedImport => {
        if (!(e instanceof ApiClientError) || isSignedOut(e) || isKernelUnavailable(e)) throw e;
        const { status, code, message, details, rawDetails } = e;
        return { problem: { status, code, message, details, rawDetails } };
      },
    ),
  );
  // Keyed by the staged import: back / forward between two `?staging=` values remounts the wizard.
  return <PluginImportWizard key={staging} initial={staged} />;
}
