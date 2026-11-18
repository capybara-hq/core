import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import type { ConversationsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { ConversationAccess } from "./access.js";
export type PermissionRoot = Selectable<ConversationsTable>;

/** Stored root state and the existing live access checks, without profile views or lifecycle calls. */
@Injectable()
export class PermissionProfileStore {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ConversationAccess) private readonly access: ConversationAccess,
  ) {}
  async own(orgId: string, id: string, accountId: string) {
    if (!(await this.access.isAccessible(orgId, id, accountId)))
      throw new ApiError("conversation.not_found", "Conversation not found");
    return this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
  }
  /** Internal stored facts; request callers use readOwnedRoot to check every ancestor. */
  async readRoot(orgId: string, id: string): Promise<PermissionRoot> {
    let row = await this.read(orgId, id);
    for (let depth = 0; row.parent_conversation_id && depth < 16; depth++)
      row = await this.read(orgId, row.parent_conversation_id);
    if (row.parent_conversation_id)
      throw new ApiError("conversation.not_found", "Conversation root not found");
    return row;
  }
  private async read(orgId: string, id: string): Promise<PermissionRoot> {
    const row = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw new ApiError("conversation.not_found", "Conversation not found");
    return row;
  }
  /** Keep the existing account, agent visibility and ancestor checks on every read. */
  async readOwnedRoot(orgId: string, id: string, accountId: string): Promise<PermissionRoot> {
    let row = await this.own(orgId, id, accountId);
    for (let depth = 0; row.parent_conversation_id && depth < 16; depth++)
      row = await this.own(orgId, row.parent_conversation_id, accountId);
    if (row.parent_conversation_id)
      throw new ApiError("conversation.not_found", "Conversation root not found");
    return row;
  }
}
