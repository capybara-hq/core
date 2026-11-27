/**
 * Read-only org facts an extension needs to build people-facing pages (collaboration spec): the
 * agents a member may use, the conversations that serve one of the extension's own subjects, and
 * the members' names and avatars. Each member of `ctx` sits behind its own permission key
 * (`permissions.agents`, `permissions.conversations`, `permissions.people`); every call names the
 * org and runs in its scope, and the extension must be enabled there.
 */

import type { BuiltinAvatarPresetId } from "./avatar-presets.js";

/**
 * An avatar a page can draw, structurally the same as the design system's `AvatarValue` (what
 * `Avatar` and `PrincipalPicker` take; the type is copied because the SDK imports no design
 * package): a built-in preset, an image (`src` is a path the web app serves, such as
 * `/api/v1/accounts/<id>/avatar?v=…`, or an absolute URL), or none (the initial is drawn).
 */
export type AvatarValue =
  | { kind: "preset"; id: BuiltinAvatarPresetId }
  | { kind: "image"; src: string }
  | null;

/** The most account ids one {@link PeopleCtx.get} call takes. */
export const PEOPLE_GET_MAX = 200;

/** The most results one {@link PeopleCtx.search} call returns (a larger `limit` is clamped). */
export const PEOPLE_SEARCH_MAX = 50;

/** The most conversations one {@link ConversationsCtx.bySubject} call returns (newest first). */
export const CONVERSATIONS_BY_SUBJECT_MAX = 200;

/** An agent a member may use. */
export interface UsableAgent {
  id: string;
  name: string;
  /** A preset stays a preset; an upload, an external image or a theme preset is an image. */
  avatar: AvatarValue;
}

/**
 * `ctx.agents` (requires `permissions.agents: { read: true }`).
 */
export interface AgentsCtx {
  /**
   * The agents `accountId` may use in the org (their own, the org's and those shared with them).
   * An account that is not an active member of the org gets `[]`.
   */
  usableBy(args: { orgId: string; accountId: string }): Promise<UsableAgent[]>;
}

/** What a conversation of a subject is doing now. */
export type SubjectConversationState = "idle" | "running" | "waiting";

/** A conversation serving a subject: metadata only, never its content. */
export interface SubjectConversation {
  id: string;
  ownerAccountId: string;
  agentId: string;
  /** From the latest run: queued or running is `running`, waiting on something is `waiting`. */
  state: SubjectConversationState;
  /** ISO time of the conversation's last activity. */
  lastActivityAt: string;
}

/**
 * `ctx.conversations` (requires `permissions.conversations: { subjects: true }`).
 */
export interface ConversationsCtx {
  /**
   * The live conversations of the org whose subject is `{ source: this extension, kind, id }`
   * (set by `subject`-mode event automations), newest activity first, at most
   * {@link CONVERSATIONS_BY_SUBJECT_MAX}. Another extension's subjects are never returned.
   */
  bySubject(args: {
    orgId: string;
    subject: { kind: string; id: string };
  }): Promise<SubjectConversation[]>;
}

/** A member as {@link PeopleCtx.get} returns it: no email or other profile field. */
export interface PersonView {
  id: string;
  name: string;
  avatar: AvatarValue;
  /** False once the account is disabled (it is still a member until removed). */
  active: boolean;
}

/**
 * `ctx.people` (requires `permissions.people: { read: true }`): members of the org only.
 */
export interface PeopleCtx {
  /** The given accounts that are members of the org (others are dropped), at most {@link PEOPLE_GET_MAX} ids. */
  get(args: { orgId: string; accountIds: string[] }): Promise<PersonView[]>;
  /**
   * Active members whose display name contains `query` (case-insensitive), by name; an empty
   * `query` returns active members up to the limit. `limit` defaults to 20 and is clamped to
   * {@link PEOPLE_SEARCH_MAX}.
   */
  search(args: {
    orgId: string;
    query: string;
    limit?: number;
  }): Promise<Pick<PersonView, "id" | "name" | "avatar">[]>;
}

/** Why a read of `ctx.agents`, `ctx.conversations` or `ctx.people` was refused. */
export type CtxReadErrorCode = "invalid_args" | "org_disabled";

/** A call of `ctx.agents` / `ctx.conversations` / `ctx.people` was refused. */
export class CtxReadError extends Error {
  readonly code: CtxReadErrorCode;

  constructor(code: CtxReadErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "CtxReadError";
    this.code = code;
  }
}
