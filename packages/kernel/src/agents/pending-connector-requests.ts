import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";

/** What {@link PendingConnectorRequests.openFor} receives: plain values, no transaction. */
export interface PendingConnectorRequestArgs {
  orgId: string;
  agentId: string;
  ownerAccountId: string;
  /** The `pendingConnectors[].key`s of the new agent's version 1. */
  keys: string[];
}

/**
 * Opens the org inbox request for a new agent's pending connectors (ruling P4-7: one
 * `connector_setup` request per agent, visible to org admins). Creating an agent from a template
 * calls it after the commit, only when the creator lacks `connectors.manage` and the agent has
 * pending connectors. The request writer itself is plugin scope phase 4 Task 6's; until then this
 * does nothing.
 */
@Injectable()
export class PendingConnectorRequests {
  constructor(@Inject(KernelDb) readonly db: KernelDb) {}

  async openFor(_args: PendingConnectorRequestArgs): Promise<void> {
    // Task 6 writes the `connector_setup` request here
  }
}
