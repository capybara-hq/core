import {
  CLIENT_API_VERSION,
  EXTENSION_NAME_RE,
  resolveUiSlots,
  type UiContribution,
  type UiSlotSpec,
  validateUiContributions,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { STALE_RECONCILE_PERIODS } from "../extensions/lifecycle-topics.js";
import {
  CLIENT_EXTENSIONS_SETTING,
  type ClientExtensionsKillSwitch,
  parseClientExtensions,
  readClientExtensions,
} from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { OrgRole } from "../orgs/roles.js";
import { StorageService } from "../storage/storage.service.js";
import { canUseSlot } from "../ui/registry.js";
import type {
  ClientExtensionItem,
  ClientExtensionsResponse,
  ClientFileRef,
} from "./client.schemas.js";
import { CLIENT_DIR, clientContentType, clientRelPath } from "./client-files.js";

/** A client build the caller may fetch files of (the row the delivery route serves from). */
export interface FetchableBuild {
  plugin: string;
  build: string;
  /** Every manifest key of the build: the entry, the styles and the assets. */
  keys: ReadonlySet<string>;
  /** The ids of the build's `component` contributions (whatever their slot's role gate). */
  components: ReadonlySet<string>;
  /** Relative to `deployment/`: `platform/client/<plugin>/<sha256>/`. */
  objectPrefix: string;
}

/** A row of {@link ClientAccess.served}. */
interface RunningBuild {
  plugin: string;
  build: string;
  section: unknown;
  entry: string | null;
  styles: string[];
  assets: string[];
  integrity: Record<string, string>;
  object_prefix: string;
}

/** The component the manifest of a stored extension section declares, with its resolved slot. */
interface ManifestComponent {
  id: string;
  slot: UiSlotSpec;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The `component` contributions of a stored extension section (`extension_packages.section`), each
 * with the catalog slot it resolves to (`resolveUiSlots`: an unknown slot or version is left out,
 * as the host drops it). The section was validated when the package was imported; an invalid one
 * (an old format) yields none.
 */
function componentsOf(section: unknown): ManifestComponent[] {
  const manifest = isObj(section) ? section.manifest : undefined;
  if (!isObj(manifest) || !Array.isArray(manifest.ui)) return [];
  if (validateUiContributions(manifest.ui, manifest.permissions).length > 0) return [];
  return resolveUiSlots(manifest.ui as UiContribution[])
    .resolved.filter(
      (r) => r.contribution.kind === "component" && r.contribution.aliasOf === undefined,
    )
    .map((r) => ({ id: r.contribution.id, slot: r.slot }));
}

/** `/api/v1/client/<plugin>/<build>/<path inside dist/client/>` of a manifest key. */
export const clientFileUrl = (plugin: string, build: string, key: string) =>
  `/api/v1/client/${plugin}/${build}/${clientRelPath(key)}`;

const fileRef = (r: RunningBuild, key: string): ClientFileRef => ({
  url: clientFileUrl(r.plugin, r.build, key),
  integrity: r.integrity[key] as string,
});

/** A served client file: its bytes and the headers that depend on it. */
export interface ClientFile {
  contentType: string;
  data: Uint8Array;
}

/** One segment of a client file path as it must appear in the URL (spec §9.1 key charset). */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const BUILD_RE = /^[0-9a-f]{64}$/;

const notFound = () => new ApiError("client.not_found", "Client file not found");

/**
 * The content type a client file is served with: the stored type, with the stylesheet's charset
 * spelled out (`text/css; charset=utf-8`; stylesheets are checked to be UTF-8 when stored).
 */
const servedType = (key: string): string =>
  key.endsWith(".css") ? "text/css; charset=utf-8" : clientContentType(key);

/**
 * The client file a delivery URL path names, as `{ plugin, build, key }`, or null. `path` is the
 * raw request path after `/api/v1/client/`, never decoded: every segment must already be made of
 * `[A-Za-z0-9._-]` and not be `.` or `..`, so an encoded separator (`%2F`, `%5C`), an encoded dot
 * (`%2e`), a backslash, an empty segment (`//`, a trailing `/`) or a dot segment names nothing.
 * The key is then `./dist/client/<segments>`: the exact manifest spelling, nothing joined or
 * normalised.
 */
export function parseClientPath(
  path: string,
): { plugin: string; build: string; key: string } | null {
  const [plugin, build, ...file] = path.split("/");
  if (plugin === undefined || !EXTENSION_NAME_RE.test(plugin)) return null;
  if (build === undefined || !BUILD_RE.test(build)) return null;
  if (file.length === 0) return null;
  if (!file.every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) return null;
  return { plugin, build, key: `./${CLIENT_DIR}${file.join("/")}` };
}

const stopped = (kill: ClientExtensionsKillSwitch, plugin: string) =>
  !kill.enabled || kill.disabled.includes(plugin);

/**
 * Whether the web host runs a build of this client API version (spec §4.2: one version before
 * 0.1.0). Imports refuse newer ones; a build the host cannot run is never listed in a shell read.
 */
const supported = (r: { api_version: number }) => r.api_version === CLIENT_API_VERSION;

/**
 * Who may load which client code (client extensions spec §9.2, §9.3, §10.2), decided from PG on
 * every request: no process state, nothing cached, so every replica answers the same and a change
 * (an org switch, an upgrade, the kill switch) applies at once.
 *
 * Client code follows the server code that actually runs. A build is **served** when its package
 * is what a live replica serves for an enabled install (`extension_replica_status.serving_sha256`,
 * heartbeat within `STALE_RECONCILE_PERIODS` reconcile intervals: the row's own package when
 * loaded, the older package still running beside a version pending approval or failed) and the
 * approved permission snapshot covers its client keys (`permissions.client` and every
 * `ui.component:<id>` of its manifest). So during an upgrade awaiting approval, or after the new
 * version's migration / setup / import failed, the old build stays served and listed and the new
 * one is not, until a replica serves it; with no live replica nothing is (fails closed). An org
 * upload awaiting the super admin has no install, so nothing of it is served. The kill switch
 * (`clientExtensions`) then stops all builds or those of the listed plugins.
 */
@Injectable()
export class ClientAccess {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * The client file a delivery request names (`path`: the raw path after `/api/v1/client/`, see
   * {@link parseClientPath}) when the account may fetch it ({@link fetchable}) and the build lists
   * it by that exact key; else 404 `client.not_found` (one answer for every reason, and never the
   * requested path in the message). The bytes come from object storage under the build's prefix;
   * the integrity a browser checks them against came from the `extension_client_builds` row.
   */
  async file(accountId: string, superAdmin: boolean, path: string): Promise<ClientFile> {
    const ref = parseClientPath(path);
    if (ref === null) throw notFound();
    const build = await this.fetchable(accountId, superAdmin, ref.plugin, ref.build);
    if (build === null || !build.keys.has(ref.key)) throw notFound();
    this.storage.assertAvailable();
    const got = await this.storage.deployment().get(build.objectPrefix + clientRelPath(ref.key));
    if (!got) throw notFound();
    return {
      contentType: servedType(ref.key),
      data: new Uint8Array(await new Response(got.body).arrayBuffer()),
    };
  }

  /**
   * The served client builds (see the class header) as a query to narrow: one row per (extension,
   * served build); during a rollout two replicas may serve two builds of one extension.
   */
  private served(db: KernelSchemaDb) {
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds;
    return db
      .selectFrom("extension_installs as i")
      .innerJoin("extension_client_builds as b", "b.plugin", "i.name")
      .innerJoin("extension_packages as p", "p.sha256", "b.package_sha256")
      .innerJoin("extension_permission_snapshots as s", "s.plugin", "i.name")
      .where("i.desired_state", "=", "enabled")
      .where(sql<boolean>`s.permissions -> 'permissions' -> 'client' = 'true'::jsonb`)
      .where(
        sql<boolean>`coalesce(s.permissions -> 'permissions' -> 'ui' -> 'components', '[]'::jsonb) @> coalesce(p.section -> 'manifest' -> 'permissions' -> 'ui' -> 'components', '[]'::jsonb)`,
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "i.name")
            .whereRef("r.serving_sha256", "=", "b.package_sha256")
            .where(
              "r.heartbeat_at",
              ">",
              sql<Date>`now() - make_interval(secs => ${staleSeconds})`,
            ),
        ),
      )
      .select([
        "i.name as plugin",
        "b.package_sha256 as build",
        "p.section as section",
        "b.entry as entry",
        "b.styles as styles",
        "b.assets as assets",
        "b.integrity as integrity",
        "b.object_prefix as object_prefix",
        "b.api_version as api_version",
      ]);
  }

  /**
   * One served build per extension, for the shell reads: the install's current package when a
   * replica serves it, else the newest build a replica still serves (the old one while the new
   * version waits for approval or failed).
   */
  private listed(db: KernelSchemaDb) {
    return this.served(db)
      .distinctOn("i.name")
      .orderBy("i.name")
      .orderBy(sql`(b.package_sha256 = i.sha256) desc`)
      .orderBy("b.created_at", "desc");
  }

  /**
   * The build `build` of `plugin` when the account may fetch its files, else null; one query, not
   * cached. It must be served (class header), not stopped by the kill switch, and the account a
   * member (any role) of a live org where the extension is enabled, or a super admin when the
   * build's manifest has a `platform.page` component (the admin console loads only those). A
   * build of a client API version the kernel does not support is never fetchable, as it is never
   * listed in a shell read.
   */
  async fetchable(
    accountId: string,
    superAdmin: boolean,
    plugin: string,
    build: string,
  ): Promise<FetchableBuild | null> {
    const db = this.db.db;
    const row = await this.served(db)
      .where("i.name", "=", plugin)
      .where("b.package_sha256", "=", build)
      .select((eb) => [
        eb
          .selectFrom("deployment_settings")
          .select("value")
          .where("key", "=", CLIENT_EXTENSIONS_SETTING)
          .as("kill"),
        // enabled.ts's two sources, per account: a required bootstrap install is on in every org,
        // otherwise the org's own switch row
        eb
          .exists(
            eb
              .selectFrom("memberships as m")
              .innerJoin("orgs as o", "o.id", "m.org_id")
              .select(sql`1`.as("one"))
              .where("m.account_id", "=", accountId)
              .where("o.deleted_at", "is", null)
              .where((w) =>
                w.or([
                  w("i.required", "=", true),
                  w.exists(
                    w
                      .selectFrom("extension_org_configs as c")
                      .select(sql`1`.as("one"))
                      .whereRef("c.org_id", "=", "m.org_id")
                      .whereRef("c.plugin", "=", "i.name")
                      .where("c.enabled", "=", true),
                  ),
                ]),
              ),
          )
          .as("member"),
      ])
      .executeTakeFirst();
    if (row === undefined) return null;
    const kill = parseClientExtensions(row.kill ?? undefined, this.log);
    if (stopped(kill, plugin) || !supported(row)) return null;
    const components = componentsOf(row.section);
    const allowed =
      row.member === true || (superAdmin && components.some((c) => c.slot.id === "platform.page"));
    if (!allowed) return null;
    return {
      plugin: row.plugin,
      build: row.build,
      keys: new Set([...(row.entry !== null ? [row.entry] : []), ...row.styles, ...row.assets]),
      components: new Set(components.map((c) => c.id)),
      objectPrefix: row.object_prefix,
    };
  }

  /**
   * The org's shell read: every extension enabled in the org (`enabled.ts`) with a served client
   * build ({@link listed}: one per extension), in name order, minus the stopped ones; `components`
   * are those whose slot the role may use (`canUseSlot`: its `minRole`, never `platform.page`). An
   * extension with no component left is still listed (its stylesheets and entry still load).
   * `signInId` gives each item the viewer's sign-in id for that plugin (`ClientSignIn`).
   */
  async orgSet(
    orgId: string,
    role: OrgRole,
    signInId: (plugin: string) => string,
  ): Promise<ClientExtensionsResponse> {
    const db = this.db.db;
    const [kill, rows] = await Promise.all([
      readClientExtensions(db, this.log),
      this.listed(db).where("i.name", "in", enabledExtensionsQuery(db, orgId)).execute(),
    ]);
    if (!kill.enabled) return { enabled: false, apiVersion: CLIENT_API_VERSION, items: [] };
    const items = rows
      .filter((r) => !stopped(kill, r.plugin) && supported(r))
      .map(
        (r): ClientExtensionItem => ({
          plugin: r.plugin,
          build: r.build,
          entry: r.entry === null ? null : fileRef(r, r.entry),
          styles: r.styles.map((k) => fileRef(r, k)),
          components: componentsOf(r.section)
            .filter((c) => canUseSlot(c.slot, role))
            .map((c) => ({ id: c.id, slot: c.slot.id })),
          signInId: signInId(r.plugin),
        }),
      );
    return { enabled: true, apiVersion: CLIENT_API_VERSION, items };
  }

  /**
   * The admin console's set (spec §9.6): the extensions with a served build (whatever their org
   * enablement) with at least one `platform.page` component and an entry, only those components
   * and no stylesheets (the admin console runs no org client code); with `plugin`, at most that one.
   */
  async platformSet(
    signInId: (plugin: string) => string,
    plugin?: string,
  ): Promise<ClientExtensionsResponse> {
    const db = this.db.db;
    let q = this.listed(db);
    if (plugin !== undefined) q = q.where("i.name", "=", plugin);
    const [kill, rows] = await Promise.all([readClientExtensions(db, this.log), q.execute()]);
    if (!kill.enabled) return { enabled: false, apiVersion: CLIENT_API_VERSION, items: [] };
    const items = rows.flatMap((r): ClientExtensionItem[] => {
      if (stopped(kill, r.plugin) || !supported(r) || r.entry === null) return [];
      const components = componentsOf(r.section)
        .filter((c) => c.slot.id === "platform.page")
        .map((c) => ({ id: c.id, slot: c.slot.id }));
      if (components.length === 0) return [];
      return [
        {
          plugin: r.plugin,
          build: r.build,
          entry: fileRef(r, r.entry),
          styles: [],
          components,
          signInId: signInId(r.plugin),
        },
      ];
    });
    return { enabled: true, apiVersion: CLIENT_API_VERSION, items };
  }
}
