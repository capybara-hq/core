import DeviceLinkView from "./view";

/**
 * `/devices/link?code=XXXX-XXXX` (signed in; the layout sent a signed-out visitor to sign-in and
 * back): `capybara-device login` opens it, or the person types the code shown in the terminal.
 * `org=<id>` (the desktop client's connect flow) preselects that org when the person is in it.
 * The view reads the machine behind the code from the cache the (auth) layout prefetched;
 * confirming and denying stay in the browser.
 */
export default async function DeviceLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[]; org?: string | string[] }>;
}) {
  const { code, org } = await searchParams;
  return (
    <DeviceLinkView
      code={typeof code === "string" ? code : ""}
      org={typeof org === "string" ? org : undefined}
    />
  );
}
