import { listAuthSources } from "../../../../lib/auth-sources";
import { listIdentities } from "../../../../lib/identities";
import { read, section } from "../../../../lib/server/page";
import { getSession } from "../../../../lib/server/session";
import Identities from "./view";

/**
 * `/account/identities` (any signed-in person; no org needed, so no readiness gate): the linked
 * identities (required) and the login plugins that offer 验证 (a section), read on the server.
 */
export default async function IdentitiesPage() {
  await getSession();
  const [{ identities }, sources] = await Promise.all([
    read(listIdentities()),
    section(listAuthSources()),
  ]);
  return (
    <Identities
      initial={{
        identities,
        loginPlugins: sources === null ? null : sources.sources.map((x) => x.plugin),
      }}
    />
  );
}
