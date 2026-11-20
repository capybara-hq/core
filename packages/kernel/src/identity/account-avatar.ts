import { createHash } from "node:crypto";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import type { Account } from "./accounts.js";

/**
 * The avatar of a person (account profile spec §5): their own upload (`accounts.avatar`), else the
 * `https:` avatar of their most recently refreshed non-local identity, else none (the UI draws
 * the initial). One helper builds every person's `avatarUrl`, so every surface agrees.
 */

/** `accounts.avatar`: the person's own avatar (null: none). */
export type AccountAvatar = { kind: "upload"; uploadId: string };

/** A person as a response names them: id, display name and avatar URL. */
export interface PersonRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** An `Account` as `/me` and the admin account routes return it. */
export type AccountView = Account & {
  avatarUrl: string | null;
  /** Where the shown image comes from: the person's upload, or the identity source (e.g. "lark:t1"). */
  avatarSource: { kind: "upload" } | { kind: "identity"; source: string } | null;
};

/** The `accounts.avatar` value when it is a well-formed upload reference, else null. */
function ownAvatar(raw: unknown): AccountAvatar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as { kind?: unknown; uploadId?: unknown };
  return v.kind === "upload" && typeof v.uploadId === "string" && v.uploadId !== ""
    ? { kind: "upload", uploadId: v.uploadId }
    : null;
}

/** The URL itself when it parses with the `https:` protocol, else null. */
export function safeSsoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** First 10 chars of the base64url sha256 of the avatar value: changes bust browser caches. */
function version(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 10);
}

/** Pure: own upload first, else an https SSO URL, else null. */
export function accountAvatarUrl(row: {
  id: string;
  avatar: AccountAvatar | null;
  ssoAvatarUrl: string | null;
}): string | null {
  const own = ownAvatar(row.avatar);
  const value = own ? `upload:${own.uploadId}` : safeSsoUrl(row.ssoAvatarUrl);
  if (value === null) return null;
  const ver = version(own ? value : `sso:${value}`);
  return `/api/v1/accounts/${encodeURIComponent(row.id)}/avatar?v=${ver}`;
}

// biome-ignore lint/suspicious/noExplicitAny: works on any query that has `accounts` joined
type AnyAccountsEb = ExpressionBuilder<KernelDatabase, any>;

/**
 * A correlated subquery on the identity whose avatar is shown for `<alias>.id`: the most recently
 * refreshed non-local identity with an `https://` avatar (ties broken by key, so the url and the
 * source subqueries pick the same row).
 */
function ssoIdentity(eb: AnyAccountsEb, alias: string, column: "url" | "source") {
  return eb
    .selectFrom("identities as avatar_identity")
    .select(
      column === "url"
        ? sql<string | null>`avatar_identity.profile->>'avatarUrl'`.as("value")
        : sql<string | null>`avatar_identity.source`.as("value"),
    )
    .where(sql.ref("avatar_identity.account_id"), "=", sql.ref(`${alias}.id`))
    .where("avatar_identity.source", "<>", "local")
    .where(sql`avatar_identity.profile->>'avatarUrl'`, "like", "https://%")
    .orderBy(sql`avatar_identity.updated_at desc nulls last`)
    .orderBy("avatar_identity.created_at", "desc")
    .orderBy("avatar_identity.source")
    .orderBy("avatar_identity.external_id")
    .limit(1);
}

/**
 * Kysely select fragment for any query already joined to `accounts` (alias param):
 * `<alias>.avatar` and a correlated subquery `sso_avatar_url`.
 */
export function avatarColumns(eb: AnyAccountsEb, alias = "accounts") {
  return [
    sql<AccountAvatar | null>`${sql.ref(`${alias}.avatar`)}`.as("avatar"),
    ssoIdentity(eb, alias, "url").as("sso_avatar_url"),
  ] as const;
}

interface AvatarRow {
  id: string;
  display_name: string;
  avatar: AccountAvatar | null;
  sso_avatar_url: string | null;
  sso_avatar_source: string | null;
}

/** Reads the avatar columns (plus the SSO source) of the given accounts in one query. */
async function avatarRows(
  db: Kysely<KernelDatabase>,
  ids: readonly string[],
): Promise<AvatarRow[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom("accounts")
    .select((eb) => [
      "accounts.id",
      "accounts.display_name",
      ...avatarColumns(eb, "accounts"),
      ssoIdentity(eb, "accounts", "source").as("sso_avatar_source"),
    ])
    .where("accounts.id", "in", [...new Set(ids)])
    .execute();
}

/** One query: ids → PersonRef (missing ids are absent from the map). */
export async function loadPeople(
  db: Kysely<KernelDatabase>,
  ids: readonly string[],
): Promise<Map<string, PersonRef>> {
  const people = new Map<string, PersonRef>();
  for (const r of await avatarRows(db, ids)) {
    people.set(r.id, {
      id: r.id,
      name: r.display_name,
      avatarUrl: accountAvatarUrl({ id: r.id, avatar: r.avatar, ssoAvatarUrl: r.sso_avatar_url }),
    });
  }
  return people;
}

/** The given accounts with `avatarUrl` and `avatarSource`, in their order (one query). */
export async function withAvatarUrls(
  db: Kysely<KernelDatabase>,
  accounts: readonly Account[],
): Promise<AccountView[]> {
  const rows = new Map(
    (
      await avatarRows(
        db,
        accounts.map((a) => a.id),
      )
    ).map((r) => [r.id, r]),
  );
  return accounts.map((a) => {
    const r = rows.get(a.id);
    const avatar = ownAvatar(r?.avatar);
    const sso = safeSsoUrl(r?.sso_avatar_url);
    const avatarSource: AccountView["avatarSource"] = avatar
      ? { kind: "upload" }
      : sso !== null && r?.sso_avatar_source
        ? { kind: "identity", source: r.sso_avatar_source }
        : null;
    return {
      ...a,
      avatarUrl: accountAvatarUrl({ id: a.id, avatar, ssoAvatarUrl: sso }),
      avatarSource,
    };
  });
}
