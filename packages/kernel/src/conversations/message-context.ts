import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { sanitizeSenderName } from "../runtime/context/run-context.js";
import { isTimeZone } from "../time-zone.js";
import type { EventPayload } from "./events.js";

/** The name of an anonymous IM guest whose IM profile gives none. */
export const ANONYMOUS_SENDER_NAME = "Anonymous guest";

/** What the browser sent with a message (run context spec §3.4); both optional. */
export interface BrowserContext {
  timeZone?: string | undefined;
  locale?: "zh" | "en" | undefined;
}

/**
 * What an IM platform gave for the sender of a message (channel@1 `sender.timeZone` /
 * `sender.locale`, normalized by {@link imSenderContext}); both optional.
 */
export interface ImSenderContext {
  timeZone?: string | undefined;
  locale?: "zh" | "en" | undefined;
}

/**
 * An IM sender's language tag as a run-context language: `zh` and `zh-*` / `zh_*` (any case) are
 * Chinese, any other non-empty tag English; not a string or blank: undefined.
 */
export function imLocale(tag: unknown): "zh" | "en" | undefined {
  if (typeof tag !== "string") return undefined;
  const t = tag.trim().toLowerCase();
  if (t === "" || t.length > 64) return undefined;
  return t === "zh" || t.startsWith("zh-") || t.startsWith("zh_") ? "zh" : "en";
}

/**
 * The time zone and language an inbound channel event's sender carries (values from an extension,
 * so checked here): a time zone the runtime knows, the language normalized by {@link imLocale}.
 */
export function imSenderContext(sender: { timeZone?: unknown; locale?: unknown }): ImSenderContext {
  const tz = sender.timeZone;
  const locale = imLocale(sender.locale);
  return {
    ...(typeof tz === "string" && isTimeZone(tz) && { timeZone: tz }),
    ...(locale !== undefined && { locale }),
  };
}

/** How many of the person's latest web conversations {@link latestWebLocale} looks at. */
export const WEB_LOCALE_CONVERSATIONS = 20;

/**
 * The UI language of the person's most recent web message in the org (run context spec §3.4):
 * the latest `user_message` they wrote in each of their {@link WEB_LOCALE_CONVERSATIONS} most
 * recently updated chat conversations that are not IM threads, the newest one with a recorded
 * `locale`. Bounded and index-friendly: `conversations_account_idx`, then one backwards primary-key
 * walk per conversation that stops at its latest user message. Undefined when none.
 */
export async function latestWebLocale(
  t: KernelSchemaDb,
  orgId: string,
  accountId: string,
): Promise<"zh" | "en" | undefined> {
  const r = await sql<{ locale: string | null }>`
    SELECT m.locale FROM (
      SELECT c.id FROM capybara.conversations c
      WHERE c.org_id = ${orgId} AND c.account_id = ${accountId} AND c.kind = 'chat'
        AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM capybara.channel_threads th WHERE th.conversation_id = c.id)
      ORDER BY c.updated_at DESC
      LIMIT ${WEB_LOCALE_CONVERSATIONS}
    ) c
    CROSS JOIN LATERAL (
      SELECT e.payload->>'locale' AS locale, e.created_at FROM capybara.conversation_events e
      WHERE e.conversation_id = c.id AND e.type = 'user_message'
        AND e.payload->>'authorAccountId' = ${accountId}
      ORDER BY e.seq DESC
      LIMIT 1
    ) m
    WHERE m.locale IN ('zh', 'en')
    ORDER BY m.created_at DESC
    LIMIT 1`.execute(t);
  const locale = r.rows[0]?.locale;
  return locale === "zh" || locale === "en" ? locale : undefined;
}

/**
 * The language of kernel-generated IM text for one person (run context spec §3.4, maintainer
 * decision 2026-11-08: in IM, language is per person): `im` (what the IM platform gave for the
 * sender, already normalized by {@link imLocale}), else the UI language of the person's most recent
 * web message in the org ({@link latestWebLocale}; no account, e.g. a speaker not resolved yet or
 * the shared anonymous guest: skipped), else the org's `locale`. Read from PG on every call: no
 * cache, so every replica answers the same.
 */
export async function recipientLocale(
  t: KernelSchemaDb,
  input: { orgId: string; accountId?: string | null | undefined; im?: "zh" | "en" | undefined },
): Promise<"zh" | "en"> {
  if (input.im !== undefined) return input.im;
  if (input.accountId) {
    const web = await latestWebLocale(t, input.orgId, input.accountId);
    if (web !== undefined) return web;
  }
  return (await readOrgSettings(t, input.orgId)).locale;
}

/** The `user_message` fields {@link readMessageContext} fills. */
export type MessageContext = Pick<EventPayload<"user_message">, "sender" | "timeZone" | "locale">;

/**
 * Who wrote a message and in which time zone and language (run context spec §3.2, §3.4), read in
 * the message's transaction (`t`):
 * - `sender`: the account's display name and org role at send time; the org's anonymous guest
 *   account (`org_anonymous_accounts`) is `{ name: <senderName, else "Anonymous guest">, role:
 *   "guest", anonymous: true }`. Names are sanitised; an empty one leaves `sender` out.
 * - `timeZone`: what the IM platform gave for the sender (`im`, when valid), else the account's
 *   setting, else the browser's (when valid), else the org default, else UTC. The anonymous guest
 *   account has no setting of its own, so it gets the IM value or the org default.
 * - `locale`: the IM platform's value, else the browser's UI language, else the UI language of the
 *   person's most recent web message in the org ({@link latestWebLocale}; not for the shared
 *   anonymous guest account), else the org's `locale`.
 *
 * The values used are recorded on the message, so the run context is derived from the log.
 */
export async function readMessageContext(
  t: KernelSchemaDb,
  input: {
    orgId: string;
    accountId: string;
    /** An anonymous IM guest's IM profile name. */
    senderName?: string | undefined;
    browser?: BrowserContext | undefined;
    /** An IM message: what the platform gave for the sender (maintainer decision 2026-11-08). */
    im?: ImSenderContext | undefined;
  },
): Promise<MessageContext> {
  const row = await t
    .selectFrom("accounts")
    .leftJoin("memberships", (j) =>
      j
        .onRef("memberships.account_id", "=", "accounts.id")
        .on("memberships.org_id", "=", input.orgId),
    )
    .leftJoin("org_anonymous_accounts as anon", (j) =>
      j.onRef("anon.account_id", "=", "accounts.id").on("anon.org_id", "=", input.orgId),
    )
    .select([
      "accounts.display_name",
      "accounts.time_zone",
      "memberships.role",
      "anon.account_id as anonymous",
    ])
    .where("accounts.id", "=", input.accountId)
    .executeTakeFirst();
  const org = await readOrgSettings(t, input.orgId);
  const anonymous = row?.anonymous !== null && row?.anonymous !== undefined;
  let sender: MessageContext["sender"];
  if (row !== undefined) {
    const name = anonymous
      ? sanitizeSenderName(input.senderName ?? "") || ANONYMOUS_SENDER_NAME
      : sanitizeSenderName(row.display_name);
    if (name !== "") {
      sender = anonymous
        ? { name, role: "guest", anonymous: true }
        : { name, ...(row.role !== null && { role: row.role }) };
    }
  }
  const im = input.im?.timeZone;
  const own = row?.time_zone ?? null;
  const browser = input.browser?.timeZone;
  const timeZone =
    im !== undefined && isTimeZone(im)
      ? im
      : own !== null && isTimeZone(own)
        ? own
        : browser !== undefined && isTimeZone(browser)
          ? browser
          : (org.timeZone ?? "UTC");
  const locale =
    input.im?.locale ??
    input.browser?.locale ??
    (row !== undefined && !anonymous
      ? await latestWebLocale(t, input.orgId, input.accountId)
      : undefined) ??
    org.locale;
  return {
    ...(sender !== undefined && { sender }),
    timeZone,
    locale,
  };
}
