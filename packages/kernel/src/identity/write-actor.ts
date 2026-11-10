import { type Principal, patTokenId, requireUser } from "./principal.js";

/**
 * Who performs a write on the platform's behalf (a super admin acting on an org they need not be
 * a member of): the account and, for a write made with a personal access token, the token id.
 */
export interface WriteActor {
  accountId: string;
  tokenId?: string;
}

/** The writer of a request: its user and, for a personal access token, the token id. */
export function writeActorOf(principal: Principal): WriteActor {
  const user = requireUser(principal);
  const tokenId = patTokenId(user);
  return { accountId: user.account.id, ...(tokenId !== undefined && { tokenId }) };
}
