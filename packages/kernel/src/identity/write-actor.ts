/**
 * Who performs a write on the platform's behalf (a super admin acting on an org they need not be
 * a member of): the account and, for a write made with a personal access token, the token id.
 */
export interface WriteActor {
  accountId: string;
  tokenId?: string;
}
