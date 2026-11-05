import Tokens from "./view";

/**
 * `/settings/tokens` (org admins): the org's service tokens. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function TokensPage() {
  return <Tokens />;
}
