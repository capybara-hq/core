import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import type { DeviceSandboxLevel } from "../runtime/context/device-paths.js";
import { isInternalProvider, SandboxProviders } from "../sandbox/providers.js";
import { deviceNotFound, sandboxUnavailable } from "../sandbox/sandbox.service.js";
import { DeviceAccess } from "./access.js";
import { DevicesService } from "./devices.service.js";

/** `details[0].reason` of the error an anonymous IM conversation's sandbox call gets. */
export const ANONYMOUS_NO_DEVICE = "anonymous";

/** Anonymous IM senders have no device (spec §4.2 item 8): their sandbox tools are off. */
export const anonymousNoDevice = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Anonymous IM senders have no device, so the sandbox is not available",
    [{ reason: ANONYMOUS_NO_DEVICE }],
  );

/** How a new conversation picks its device. */
export interface NewConversationDevice {
  /** The device the person chose (the composer's picker); checked with `usable`. */
  deviceId?: string;
  /** An IM thread: the person's IM default (`device_defaults`) when still usable. */
  im?: boolean;
}

/**
 * Which device a conversation works in (spec 2026-11-07-environments-design §4.1 items 1, 3;
 * §4.2 items 8, 9, 12). A conversation is bound once, to a device of its owner
 * (`conversations.account_id`): the one chosen at its first send, else the owner's IM default
 * (IM threads), else the owner's default device. Its sub-agents use the root's. Access is
 * checked when it is bound and again on every sandbox tool call ({@link forTool}); only the owner
 * may use a personal device, so a conversation never reaches another person's.
 */
@Injectable()
export class ConversationDevices {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "cloud"> &
      Partial<Pick<SandboxProviders, "forName">>,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(DevicesService)
    private readonly devices: Pick<DevicesService, "ensureDefault" | "sandboxLevel">,
  ) {}

  /**
   * The sandbox level a call in the device runs at now ({@link DevicesService.sandboxLevel}),
   * recorded for the model in `device_paths` (sandbox dev tiers spec §11.5); `runId`: the calling
   * run, whose scheduled-run cap applies.
   */
  sandboxLevel(
    orgId: string,
    deviceId: string,
    runId?: string,
  ): Promise<DeviceSandboxLevel | null> {
    return this.devices.sandboxLevel(orgId, deviceId, runId);
  }

  /**
   * The device a new conversation of `accountId` is bound to: the chosen one when it is
   * usable by the person (else `device.not_found` / `device.unavailable`, and nothing
   * is created); without a choice the IM default (IM only) or the person's default device.
   * Null (unbound) for anonymous IM senders, and without a cloud sandbox provider when no usable
   * IM default (a connected machine's device, say) applies.
   */
  async forNew(
    orgId: string,
    accountId: string,
    pick: NewConversationDevice = {},
  ): Promise<string | null> {
    if (pick.deviceId !== undefined) {
      return (await this.access.usable(orgId, accountId, pick.deviceId)).id;
    }
    if (pick.im !== true && this.providers.cloud() === undefined) return null;
    if (await this.isAnonymous(orgId, accountId)) return null;
    return this.defaultFor(orgId, accountId, pick.im === true);
  }

  /**
   * The device a sandbox tool call of the conversation tree rooted at `rootConversationId`
   * enters, checked for its owner now. A conversation still unbound (created before
   * devices, or while no provider existed) is bound first, to the owner's IM default when it
   * is an IM thread, else to the owner's default device; a racing call binds it once.
   * Throws `sandbox.unavailable` for a cloud device (or none to bind) without a cloud
   * provider and for an anonymous IM conversation, and `device.not_found` /
   * `device.unavailable` when the owner may not use it now. A conversation bound to a
   * connected machine's device (`@local`) does not need a cloud provider.
   */
  async forTool(orgId: string, rootConversationId: string): Promise<string> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "device_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv) throw deviceNotFound();
    if (await this.isAnonymous(orgId, conv.account_id)) throw anonymousNoDevice();
    let deviceId = conv.device_id;
    if (deviceId === null) {
      const im = await this.isImThread(rootConversationId);
      const chosen = await this.defaultFor(orgId, conv.account_id, im);
      if (chosen === null) throw sandboxUnavailable();
      deviceId = await this.bind(rootConversationId, chosen);
    }
    if (this.providers.cloud() === undefined && !(await this.isInternal(deviceId))) {
      throw sandboxUnavailable();
    }
    return (await this.access.usable(orgId, conv.account_id, deviceId)).id;
  }

  /**
   * Whether a sandbox tool call of the tree rooted at `rootConversationId` has a provider to run
   * on, for tool listings (ruling R8; no binding, no access check, never throws): a cloud
   * provider is loaded, or the device the conversation is bound to (an unbound IM thread:
   * its owner's IM default) runs on a registered kernel provider (`@local`). A forbidden or gone
   * device still counts: the call then says why.
   */
  async usableNow(orgId: string, rootConversationId: string): Promise<boolean> {
    if (this.providers.cloud() !== undefined) return true;
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "device_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv) return false;
    let deviceId = conv.device_id;
    if (deviceId === null) {
      if (!(await this.isImThread(rootConversationId))) return false;
      const row = await this.db
        .selectFrom("device_defaults")
        .select("device_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", conv.account_id)
        .executeTakeFirst();
      if (!row) return false;
      deviceId = row.device_id;
    }
    const env = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    const provider = env?.provider ?? null;
    return (
      provider !== null &&
      isInternalProvider(provider) &&
      this.providers.forName?.(provider) !== undefined
    );
  }

  /**
   * The person's IM default when `im` and it is still theirs, live, in this org and usable (the
   * table has no such guard), else their default device (created when missing); null when
   * that is needed and there is no cloud provider to make or use it. The owner having left the org
   * reads as `device.not_found`.
   */
  private async defaultFor(orgId: string, accountId: string, im: boolean): Promise<string | null> {
    if (im) {
      const row = await this.db
        .selectFrom("device_defaults")
        .select("device_id")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      if (row) {
        try {
          return (await this.access.usable(orgId, accountId, row.device_id)).id;
        } catch (e) {
          if (!isDeviceGone(e)) throw e;
        }
      }
    }
    if (this.providers.cloud() === undefined) return null;
    try {
      return await this.devices.ensureDefault(orgId, accountId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "org.not_found") throw deviceNotFound();
      throw e;
    }
  }

  /** Binds an unbound conversation to `deviceId`; returns what it is bound to now. */
  @Transactional()
  private async bind(conversationId: string, deviceId: string): Promise<string> {
    await this.db
      .updateTable("conversations")
      .set({ device_id: deviceId })
      .where("id", "=", conversationId)
      .where("device_id", "is", null)
      .execute();
    const row = await this.db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    return row.device_id ?? deviceId;
  }

  /** The device runs on a kernel-internal provider (`@local`). */
  private async isInternal(deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    const provider = row?.provider ?? null;
    return provider !== null && isInternalProvider(provider);
  }

  /** The account is the org's anonymous IM guest (no person behind it). */
  private async isAnonymous(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("org_anonymous_accounts")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The conversation is (or was) an IM thread's. */
  private async isImThread(conversationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("channel_threads")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}

const isDeviceGone = (e: unknown): boolean =>
  e instanceof ApiError && (e.code === "device.not_found" || e.code === "device.unavailable");
