import SkillsView from "./view";

/**
 * `/skills`: the org's skill library (members up). It reads nothing: the layout prefetches the list
 * on a first load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function SkillsPage() {
  return <SkillsView />;
}
