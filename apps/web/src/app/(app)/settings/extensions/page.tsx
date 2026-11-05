import Extensions from "./view";

/**
 * `/settings/extensions` (org admins): the org's extensions and the file previewers. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function ExtensionsPage() {
  return <Extensions />;
}
