import DeviceLinkView from "./view";

/**
 * `/devices/link?code=XXXX-XXXX` (signed in; the layout sent a signed-out visitor to sign-in and
 * back): `capybara-device login` opens it, or the person types the code shown in the terminal.
 * The view reads the machine behind the code from the cache the (auth) layout prefetched;
 * confirming and denying stay in the browser.
 */
export default async function DeviceLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  return <DeviceLinkView code={typeof code === "string" ? code : ""} />;
}
