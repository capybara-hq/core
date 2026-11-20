import { sql } from "kysely";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";

/** What an `avatarUrl` of a person with an own upload looks like (the version is a hash). */
export const UPLOAD_AVATAR_URL = (accountId: string) =>
  `/api/v1/accounts/${accountId}/avatar?v=` as const;

/** Gives the account an own upload avatar by writing `accounts.avatar` directly. */
export async function giveUploadAvatar(
  db: KernelSchemaDb,
  accountId: string,
  uploadId = `up-${accountId}`,
): Promise<void> {
  await sql`UPDATE capybara.accounts SET avatar = ${JSON.stringify({ kind: "upload", uploadId })}::jsonb WHERE id = ${accountId}`.execute(
    db,
  );
}
