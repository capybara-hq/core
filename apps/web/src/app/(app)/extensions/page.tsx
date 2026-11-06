import { parseExtensionTab } from "../../../lib/extension-capabilities";
import Extensions from "./view";

/**
 * `/extensions` (members read the extensions' state; org admins also edit them and see the
 * default providers and the file previewers), by capability (`?tab=<id>`, default 全部). It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default async function ExtensionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[] }>;
} = {}) {
  const raw = (await searchParams)?.tab;
  return <Extensions tab={parseExtensionTab(Array.isArray(raw) ? raw[0] : raw)} />;
}
