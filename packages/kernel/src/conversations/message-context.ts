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

/** The `user_message` fields {@link readMessageContext} fills. */
export type MessageContext = Pick<EventPayload<"user_message">, "sender" | "timeZone" | "locale">;

/**
 * Who wrote a message and in which time zone and language (run context spec §3.2, §3.4), read in
 * the message's transaction (`t`):
 * - `sender`: the account's display name and org role at send time; the org's anonymous guest
 *   account (`org_anonymous_accounts`) is `{ name: <senderName, else "Anonymous guest">, role:
 *   "guest", anonymous: true }`. Names are sanitised; an empty one leaves `sender` out.
 * - `timeZone`: the account's setting, else the browser's (when valid), else the org default, else
 *   UTC. The anonymous guest account has no setting of its own, so it gets the org default.
 * - `locale`: the browser's UI language, else the org's `locale`.
 */
export async function readMessageContext(
  t: KernelSchemaDb,
  input: {
    orgId: string;
    accountId: string;
    /** An anonymous IM guest's IM profile name. */
    senderName?: string | undefined;
    browser?: BrowserContext | undefined;
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
  const own = row?.time_zone ?? null;
  const browser = input.browser?.timeZone;
  const timeZone =
    own !== null && isTimeZone(own)
      ? own
      : browser !== undefined && isTimeZone(browser)
        ? browser
        : (org.timeZone ?? "UTC");
  return {
    ...(sender !== undefined && { sender }),
    timeZone,
    locale: input.browser?.locale ?? org.locale,
  };
}
