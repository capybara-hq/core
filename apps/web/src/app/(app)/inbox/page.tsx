import InboxView from "./view";

/**
 * `/inbox`: the current org's pending items, with the detail of the first one (it is selected at
 * once) when it is a skill change. It reads nothing: the layout prefetches them on a first load
 * (`lib/query/routes.ts`); other items' details load when picked.
 */
export default function InboxPage() {
  return <InboxView />;
}
