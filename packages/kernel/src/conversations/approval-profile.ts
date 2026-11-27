import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { PermissionFacts } from "../sandbox/permission-facts.js";
import { PermissionFactsModule } from "../sandbox/permission-facts.module.js";

/** A root conversation's effective permission profile and the revision it was read at. */
export interface ApprovalProfile {
  profile: PermissionProfile;
  revision: number;
}

/**
 * Resolves the profile that decides an ask addressed to the conversation's person (profiles govern
 * every approval, ruling R1). Only an interactive chat (`kind = 'chat'`, no automation) whose
 * owner is the person asked has one: any other root, an automation's conversation or an ask
 * addressed to another account keeps asking. The profile is the root's effective one as the
 * permission view reads it (Auto falls back to Approve for me where a bound device's consent no
 * longer holds; without a device Auto holds, ruling R8).
 */
@Injectable()
export class ConversationApprovalProfile {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(PermissionFacts) private readonly facts: Pick<PermissionFacts, "viewWithAccess">,
  ) {}

  /** The root's effective profile for an ask addressed to `requestedFor`; null: the profile does not apply (R1). */
  async resolve(input: {
    orgId: string;
    rootConversationId: string;
    requestedFor: string;
  }): Promise<ApprovalProfile | null> {
    const row = await this.db.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", input.rootConversationId)
      .where("org_id", "=", input.orgId)
      .executeTakeFirst();
    if (
      row === undefined ||
      row.kind !== "chat" ||
      row.automation_id !== null ||
      row.account_id !== input.requestedFor
    )
      return null;
    const { view } = await this.facts.viewWithAccess(input.orgId, row.account_id, row);
    return { profile: view.profile, revision: view.revision };
  }
}

/** {@link ConversationApprovalProfile} on its own (the tools module reads it; no module cycle). */
@Module({
  imports: [PermissionFactsModule],
  providers: [ConversationApprovalProfile],
  exports: [ConversationApprovalProfile],
})
export class ConversationApprovalProfileModule {}
