import { redirect } from "next/navigation";
import LinkView from "./view";

/**
 * `/login/link?ticket=…` (login extensions spec §5): a third-party sign-in whose external account
 * has no Capybara account that can sign in finishes here with a username and password. Without a
 * ticket there is nothing to finish: back to sign-in with `sso.link_expired`. The view reads the
 * pending link in the browser (the request for this page does not carry the `cap_sso` cookie the
 * kernel checks). The proxy sends this page with `referrer-policy: no-referrer`.
 */
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ ticket?: string | string[] }>;
}) {
  const { ticket } = await searchParams;
  if (typeof ticket !== "string" || ticket === "") redirect("/login?error=sso.link_expired");
  return <LinkView ticket={ticket} />;
}
