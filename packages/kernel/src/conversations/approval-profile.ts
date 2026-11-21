import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { Injectable } from "@nestjs/common";

/** A root conversation's effective permission profile and the revision it was read at. */
export interface ApprovalProfile {
  profile: PermissionProfile;
  revision: number;
}

/**
 * Resolves the profile that decides an ask addressed to the conversation's person (profiles govern
 * every approval, ruling R1). Not provided in a module yet: the pipeline's profile step wires it.
 */
@Injectable()
export class ConversationApprovalProfile {
  /** The root's effective profile for an ask addressed to `requestedFor`; null: the profile does not apply (R1). */
  async resolve(_input: {
    orgId: string;
    rootConversationId: string;
    requestedFor: string;
  }): Promise<ApprovalProfile | null> {
    throw new Error("ConversationApprovalProfile.resolve is not implemented yet");
  }
}
