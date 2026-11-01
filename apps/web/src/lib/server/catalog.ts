import "server-only";
import type { CatalogInstallData } from "../../components/CatalogInstallWizard";
import { getOrgCatalogItem } from "../catalog";
import { listOrgExtensions } from "../extensions";
import { read, section } from "./page";

/**
 * What the catalog install wizard starts from (web-SSR spec §6): the item (required: a missing
 * one is the not-found page) and the org's extensions, a section (`null` when the kernel refuses
 * or fails it: the wizard then asks no extension config).
 */
export async function loadCatalogInstall(
  orgId: string,
  itemId: string,
): Promise<CatalogInstallData> {
  const [detail, extensions] = await Promise.all([
    read(getOrgCatalogItem(orgId, itemId)),
    section(listOrgExtensions(orgId)),
  ]);
  return { detail, extensions: extensions?.extensions ?? null };
}
