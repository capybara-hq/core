import Extensions from "./view";

/**
 * `/extensions` (members read the extensions' state; org admins also edit them and see the
 * default providers and the file previewers). It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function ExtensionsPage() {
  return <Extensions />;
}
