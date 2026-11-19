import AppAuthorizeView from "./view";

/**
 * `/apps/authorize?client=desktop&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…
 * &name=…&app_version=…` (signed in; the layout sent a signed-out visitor to sign-in and back): the
 * Capybara desktop app opens it in the system browser. The view asks for one confirmation.
 */
export default async function AppAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  return (
    <AppAuthorizeView
      query={{
        client: first(query.client),
        redirect_uri: first(query.redirect_uri),
        code_challenge: first(query.code_challenge),
        code_challenge_method: first(query.code_challenge_method),
        state: first(query.state),
        name: first(query.name),
        app_version: first(query.app_version),
      }}
    />
  );
}
