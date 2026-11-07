import { ACTION_MIN_ROLE, can, type OrgRole } from "../orgs/roles.js";
import type { ActorFacts } from "./actor.js";
import type { PlatformOperation } from "./operation.js";

export type Availability = { ok: true } | { ok: false; reason: string };

/** Who holds a role, as a reason names them. */
const HOLDER: Record<OrgRole, string> = {
  guest: "any org member",
  member: "an org member (not a guest)",
  admin: "an org admin",
  owner: "an org owner",
};

const refuse = (reason: string): Availability => ({ ok: false, reason });

/**
 * Whether the actor may call `op` now (spec §6), decided on facts read at call time. The reason
 * is model-visible English: it says who can do it or why not, so the agent can offer the next
 * step (a request operation, the web page, an admin) instead of retrying.
 */
export function availability(op: PlatformOperation, f: ActorFacts): Availability {
  if (f.role === null) {
    return refuse(
      "You are not a member of this org any more, or your account is disabled, so no Platform operation is available; ask an org admin to add you back or the super admin to enable your account.",
    );
  }
  if (f.setting === "off") {
    return refuse(
      "The org turned the Platform tool off; an org admin can switch it on in the organization settings.",
    );
  }
  if ("superAdmin" in op.authz) {
    if (!f.isSuperAdmin) {
      return refuse(
        "Only the super admin can do this; ask them, or use a request operation where one exists.",
      );
    }
    if (!f.agentPrivateToActor) {
      return refuse(
        "Platform-scope operations run only through your own private agent; open a conversation with a private agent you own and do it there.",
      );
    }
  } else if (!can(f.role, op.authz.orgAction)) {
    const min = ACTION_MIN_ROLE[op.authz.orgAction];
    return refuse(
      `This needs the ${min} role in the org (you are ${f.role}); ${HOLDER[min]} can do it, or use a request operation where one exists.`,
    );
  }
  if (op.confirm !== "read") {
    if (f.setting === "read-only") {
      return refuse(
        "The org set the Platform tool to read-only, so writes are unavailable; do it on the web, or ask an org admin to change the setting.",
      );
    }
    if (!f.personPresent) {
      return refuse(
        "This write needs a person to confirm it, and no person is present in this run (a scheduled, evaluation or anonymous run); only read operations are available.",
      );
    }
  }
  return { ok: true };
}
