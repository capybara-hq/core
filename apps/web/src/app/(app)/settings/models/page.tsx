import OrgModels from "./view";

/**
 * `/settings/models` (org admins; a setup step): the org's model purposes and the models they can
 * map to. It reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function OrgModelsPage() {
  return <OrgModels />;
}
