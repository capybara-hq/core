import DevicesView from "./view";

/**
 * `/devices`: the person's devices. It reads nothing: the layout prefetches the list on a
 * first load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function DevicesPage() {
  return <DevicesView />;
}
