import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { currentStore, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";
export type AuthorityLevel = "platform" | "org" | "device" | "root";
export type AuthoritySubject = { orgId?: string; deviceId?: string; rootConversationId?: string };
export type AuthorityLockIntent = { kind: "admit" } | { kind: "write"; level: AuthorityLevel };
export const authorityEntries = (s: AuthoritySubject): [AuthorityLevel, string][] => [
  ["platform", "platform"],
  ...(s.orgId ? [["org", s.orgId] as [AuthorityLevel, string]] : []),
  ...(s.deviceId ? [["device", s.deviceId] as [AuthorityLevel, string]] : []),
  ...(s.rootConversationId ? [["root", s.rootConversationId] as [AuthorityLevel, string]] : []),
];
const keyOf = (kind: AuthorityLevel, id: string) => `permission-authority-${kind}-${id}`;
/** Shared readers and exclusive changed-level writers, held until the caller commits. */
@Injectable()
export class PermissionAuthorityLock {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(XactLock) private readonly locks: XactLock,
  ) {}
  @Transactional({ propagation: "mandatory" })
  async acquire(subject: AuthoritySubject, intent: AuthorityLockIntent): Promise<void> {
    if (intent.kind === "write" && intent.level === "platform") {
      if (subject.orgId || subject.deviceId || subject.rootConversationId)
        throw new Error("Platform writes cannot acquire descendant locks");
    } else {
      if (
        !subject.orgId ||
        !(await this.db
          .selectFrom("orgs")
          .select("id")
          .where("id", "=", subject.orgId)
          .executeTakeFirst())
      )
        throw new ApiError("org.not_found", "The authority organization does not exist");
    }
    const entries = authorityEntries(subject);
    const stop =
      intent.kind === "write"
        ? entries.findIndex(([level]) => level === intent.level)
        : entries.length - 1;
    if (stop < 0) throw new Error("The changed authority level is missing");
    const store = currentStore();
    if (!store) throw new Error("Authority locks require a transaction");
    store.permissionLocks ??= new Map();
    const claims = store.permissionLocks;
    // Validate the whole acquisition before taking any locks; upgrading or reordering can deadlock.
    const wanted = entries.slice(0, stop + 1).map(([level, id], index) => ({
      key: keyOf(level, id),
      mode:
        intent.kind === "write" && index === stop ? ("exclusive" as const) : ("shared" as const),
    }));
    for (const item of wanted) {
      const held = claims.get(item.key);
      if (held === "shared" && item.mode === "exclusive")
        throw new Error(
          "Authority lock upgrades are forbidden; choose the highest write intent first",
        );
    }
    if (claims.size && wanted.some((item) => !claims.has(item.key)))
      throw new Error("Acquire the complete authority subject once in fixed order");
    for (const item of wanted) {
      if (claims.has(item.key)) continue;
      if (item.mode === "exclusive") await this.locks.lock(item.key);
      else await this.locks.shared(item.key);
      claims.set(item.key, item.mode);
    }
    if (subject.deviceId) {
      const row = await this.db
        .selectFrom("devices")
        .select("org_id")
        .where("id", "=", subject.deviceId)
        .executeTakeFirst();
      if (!row || row.org_id !== subject.orgId)
        throw new ApiError("device.not_found", "Device not found");
    }
    if (subject.rootConversationId) {
      const row = await this.db
        .selectFrom("conversations")
        .select("org_id")
        .where("id", "=", subject.rootConversationId)
        .executeTakeFirst();
      if (row && row.org_id !== subject.orgId)
        throw new ApiError("conversation.not_found", "Conversation not found");
      // A root-write may reserve the random ID before its first insert.
      if (!row && !(intent.kind === "write" && intent.level === "root"))
        throw new ApiError("conversation.not_found", "Conversation not found");
    }
  }
  assertHeld(kind: AuthorityLevel, id: string, exclusive = false): void {
    assertAuthorityHeld(kind, id, exclusive);
  }
}
/** The current transaction holds this authority lock (exclusively when asked); else throws. */
export function assertAuthorityHeld(kind: AuthorityLevel, id: string, exclusive = false): void {
  const held = currentStore()?.permissionLocks?.get(keyOf(kind, id));
  if (!held || (exclusive && held !== "exclusive"))
    throw new Error("The matching authority lock is required");
}
