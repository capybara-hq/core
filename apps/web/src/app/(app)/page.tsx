import HomeView from "./view";

/**
 * `/`: the overview of the current org. It reads nothing: once the org is ready the layout
 * prefetches the overview on a first load (`lib/query/routes.ts`), and the view reads it from the
 * cache. Until a model and an agent exist the app frame draws the setup home here instead (web-order
 * spec §3.8), and without a current org the org chooser; the view then draws nothing.
 */
export default function HomePage() {
  return <HomeView />;
}
