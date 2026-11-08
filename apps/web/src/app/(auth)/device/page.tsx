import DeviceView from "./view";

/**
 * `/device?code=XXXX-XXXX` (signed in; the layout sent a signed-out visitor to sign-in and back):
 * `capybara-device login` opens it, or the person types the code shown in the terminal. The view
 * reads the machine behind the code from the cache the (auth) layout prefetched; confirming and
 * denying stay in the browser.
 */
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  return <DeviceView code={typeof code === "string" ? code : ""} />;
}
