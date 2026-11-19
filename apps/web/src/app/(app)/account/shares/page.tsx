import MySharesView from "./view";

/**
 * `/account/shares`: the file links the person shared, revocable. It reads nothing: the layout
 * prefetches the list on a first load (`lib/query/routes.ts`).
 */
export default function MySharesPage() {
  return <MySharesView />;
}
