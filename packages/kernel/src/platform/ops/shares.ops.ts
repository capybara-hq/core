import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ListSharesQuery, ShareIdParams } from "../../shares/shares.schemas.js";
import { SharesService, type ShareView } from "../../shares/shares.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named } from "./summary.js";

const PAGE = 50;

const row = (s: ShareView) => ({
  id: s.id,
  name: s.name,
  state: s.state,
  ...(s.revokeReason !== null && { reason: s.revokeReason }),
  audience: s.audience,
  expiresAt: s.expiresAt,
  createdBy: s.createdBy.displayName,
});

/**
 * Share operations of the `Platform` tool (the conversation domain, file sharing spec §10): list
 * shared file links and revoke one. Creating and refreshing a share publish a file outside the
 * conversation and stay with the person on the web (exclusions, `human-only`).
 */
@Injectable()
export class SharesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(SharesService) private readonly shares: SharesService,
  ) {}

  /** The share's file name for a card, or its id when it is not visible to the actor. */
  private async nameOf(orgId: string, accountId: string, shareId: string): Promise<string> {
    for (const scope of ["mine", "all"] as const) {
      try {
        const found = (await this.shares.list(orgId, accountId, scope)).shares.find(
          (s) => s.id === shareId,
        );
        if (found !== undefined) return found.name;
      } catch {
        // `all` is for org admins only: the card falls back to the id
      }
    }
    return shareId;
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "conversations.list-shares",
        description:
          "List shared links to conversation files, newest first: your own (scope mine, the default) or every member's in the org (scope all, org admins only). Each row has the file name, state (live, suspended, expired, revoked), the audience (internal: signed-in members; external: anyone with the link), the expiry and who shared it; revoked and expired links stay listed for 7 days. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ scope: ListSharesQuery.shape.scope, cursor: Cursor.optional() }).strict(),
        example: { scope: "mine" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/shares"],
        extras: ["cursor"],
        confirm: "read",
        errors: [
          {
            code: "forbidden",
            next: "Only org admins list every member's shares; list your own with scope mine.",
          },
        ],
        run: async (input, ctx) =>
          pageOf(
            (await this.shares.list(ctx.orgId, ctx.actorAccountId, input.scope)).shares.map(row),
            startOf(input.cursor),
            PAGE,
          ),
      }),
      defineOperation({
        id: "conversations.revoke-share",
        description:
          "Revoke a shared link to a conversation file: the link stops working at once and its snapshot is deleted. Takes the share id from conversations.list-shares. Your own shares, or any member's for org admins. Revoking a link already revoked changes nothing. The person confirms every revoke.",
        input: z.object({ shareId: ShareIdParams.shape.shareId }).strict(),
        example: { shareId: "3f2b8a40-6c1d-4e0b-9a77-5d1e2c8b9f10" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/shares/:shareId"],
        confirm: "org",
        errors: [
          {
            code: "share.not_found",
            next: "Check the id with conversations.list-shares: only your own shares, or any member's for org admins, can be revoked.",
          },
        ],
        summary: async (i, ctx) => {
          const n = named(await this.nameOf(ctx.orgId, ctx.actorAccountId, i.shareId));
          return { zh: `撤销文件「${n}」的分享链接`, en: `Revoke the shared link to "${n}"` };
        },
        run: async (input, ctx) => {
          await this.shares.revoke(ctx.orgId, ctx.actorAccountId, input.shareId, {
            auditDetail: viaAgent("conversations.revoke-share", ctx),
          });
          return { revoked: true, shareId: input.shareId };
        },
      }),
    ]);
  }
}
