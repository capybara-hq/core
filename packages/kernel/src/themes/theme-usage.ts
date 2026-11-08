// Who uses a theme (themes spec §6 "Losing access", §7): the platform default (`deployment_settings`
// key `uiTheme`), the orgs whose default it is (`orgs.settings.theme.id`) and the people who picked
// it (`accounts.theme`); the previews of changes that take a theme away list them, and the guard
// refuses any change that takes the platform default away from an org. Plain reads in the caller's
// context (a transaction's connection when there is one).
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";

/** The deployment setting that holds the platform default theme (`{ id: string | null }`). */
export const UI_THEME_SETTING = "uiTheme";

/** Where a theme is chosen (spec §7). */
export interface ThemeUsage {
  /** It is the platform default (`uiTheme.id`). */
  platformDefault: boolean;
  /** The live orgs whose default it is, by name. */
  orgDefaults: { orgId: string; orgName: string }[];
  /** The accounts that picked it (`accounts.theme`). */
  pickedBy: number;
}

/**
 * One theme a change takes away from some orgs, as a preview lists it (`themes?` of the scope,
 * disable, uninstall and update previews): the orgs among those losing it whose default it is, and
 * the number of people who picked it among those orgs' members (a preview never counts people of
 * orgs it does not name).
 */
export interface ThemePreview {
  id: string;
  orgDefaults: { orgId: string; orgName: string }[];
  pickedBy: number;
}

/** What a theme's availability is after a change: still `all`, narrower, or gone. */
export type ThemeAfter = "all" | "narrower" | "gone";

/**
 * The platform default theme's id (null: the built-in theme, or not set). Read from the raw row so
 * this works whatever writes the setting; `lock`: the row is read FOR SHARE, so a concurrent write
 * of the setting waits for the caller's transaction (and the reverse).
 */
export async function platformDefaultThemeId(
  db: KernelSchemaDb,
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  let q = db.selectFrom("deployment_settings").select("value").where("key", "=", UI_THEME_SETTING);
  if (opts.lock) q = q.forShare();
  const row = await q.executeTakeFirst();
  const v = row?.value as { id?: unknown } | null | undefined;
  return typeof v?.id === "string" ? v.id : null;
}

/** Where theme `themeId` (a `platform_themes` id) is chosen: see {@link ThemeUsage}. */
export async function themeUsage(db: KernelSchemaDb, themeId: string): Promise<ThemeUsage> {
  const platformDefault = (await platformDefaultThemeId(db)) === themeId;
  const orgs = await db
    .selectFrom("orgs")
    .select(["id", "name"])
    .where("deleted_at", "is", null)
    .where(sql<string>`settings -> 'theme' ->> 'id'`, "=", themeId)
    .orderBy("name")
    .orderBy("id")
    .execute();
  const picked = await db
    .selectFrom("accounts")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("theme", "=", themeId)
    .executeTakeFirstOrThrow();
  return {
    platformDefault,
    orgDefaults: orgs.map((o) => ({ orgId: o.id, orgName: o.name })),
    pickedBy: Number(picked.n),
  };
}

/**
 * The `themes` block of a preview: for each theme of `lost` (theme id -> the orgs losing it) that
 * some org loses, the orgs among those whose default it is and how many of their members picked
 * it, by id.
 * Undefined when no theme is lost, so a preview without themes keeps its shape and its hash.
 */
export async function themesPreview(
  db: KernelSchemaDb,
  lost: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ThemePreview[] | undefined> {
  const out: ThemePreview[] = [];
  for (const id of [...lost.keys()].sort()) {
    const orgs = lost.get(id);
    if (!orgs || orgs.size === 0) continue;
    const u = await themeUsage(db, id);
    const picked = await db
      .selectFrom("accounts as a")
      .select((eb) => eb.fn.count<string>("a.id").distinct().as("n"))
      .where("a.theme", "=", id)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("memberships as m")
            .select("m.account_id")
            .whereRef("m.account_id", "=", "a.id")
            .where("m.org_id", "in", [...orgs]),
        ),
      )
      .executeTakeFirstOrThrow();
    out.push({
      id,
      orgDefaults: u.orgDefaults.filter((o) => orgs.has(o.orgId)),
      pickedBy: Number(picked.n),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** 409 `theme.platform_default`: theme `theme` is the platform default (spec §7). */
export const platformDefaultError = (theme: string): ApiError =>
  new ApiError(
    "theme.platform_default",
    `Theme ${theme} is the platform default theme (setting ${UI_THEME_SETTING}): it must stay on in every organization. Choose another platform default theme first, then narrow, disable or remove this one`,
    [{ theme, setting: UI_THEME_SETTING }],
  );

/**
 * Refuses a change that takes the platform default theme away from any org (spec §7): when one of
 * `themeIds` is the platform default and `after` says it would no longer be `all` (narrower, or
 * gone), 409 `theme.platform_default`. Call it in the change's transaction before anything is
 * written; the setting's row is read FOR SHARE.
 */
export async function assertNotPlatformDefault(
  db: KernelSchemaDb,
  themeIds: readonly string[],
  after: (id: string) => ThemeAfter,
): Promise<void> {
  if (themeIds.length === 0) return;
  const id = await platformDefaultThemeId(db, { lock: true });
  if (id === null || !themeIds.includes(id)) return;
  if (after(id) !== "all") throw platformDefaultError(id);
}
