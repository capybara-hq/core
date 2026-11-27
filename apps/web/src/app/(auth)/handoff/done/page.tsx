import HandoffDoneView from "./view";

/**
 * `/handoff/done?kind=…&returnTo=…[&scheme=…]` plus the callback's result (shell external
 * authorization spec §3): where a browser handoff's OAuth or login-method link flow ends, in the
 * system browser. Public: it only shows the result and links back to the app. The view reads the
 * query itself (one value per name; a repeated name is dropped, so it cannot be smuggled twice).
 */
export default async function HandoffDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const single = Object.entries(query).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
  return <HandoffDoneView search={new URLSearchParams(single).toString()} />;
}
