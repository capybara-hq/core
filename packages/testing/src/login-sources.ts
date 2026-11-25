import {
  type KernelSchemaDb,
  type LoginSourceSettings,
  writeLoginSources,
} from "@capybara-hq/kernel";

/** One entry for {@link seedLoginSources}: only `plugin` is required. */
export type LoginSourceSeed = Pick<LoginSourceSettings, "plugin"> & Partial<LoginSourceSettings>;

/**
 * Replaces the deployment's login sources (the `loginSources` deployment setting) with `entries`,
 * in this order (the login page order). Defaults: `enabled: true`, `signUp: "link"` (an unlinked
 * external account goes to the link page; pass `signUp: "create"` where a test signs up through a
 * login source), no trusted tenants. It writes the row directly through `db` (any replica reads it
 * at its next sign-in), without the admin checks: the extension need not be loaded or configured.
 * The row references `accounts`, so `TRUNCATE capybara.accounts CASCADE` empties it: seed after.
 */
export async function seedLoginSources(
  db: KernelSchemaDb,
  entries: readonly LoginSourceSeed[],
): Promise<void> {
  await writeLoginSources(
    db,
    entries.map((e) => ({
      plugin: e.plugin,
      enabled: e.enabled ?? true,
      signUp: e.signUp ?? "link",
      trustedTenants: e.trustedTenants ?? [],
    })),
    null,
  );
}
