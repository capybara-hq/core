import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { type OutboxJob, OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  PUSH_DELIVER_JOB,
  PUSH_QUEUE,
  type PushDeliverData,
  type PushFanoutData,
  pushDeliverJobId,
} from "./jobs.js";
import { PushPreferencesService } from "./preferences.service.js";
import { resolveRecipients } from "./recipients.js";
import { PushRegistrationsService } from "./registrations.service.js";
import { renderPushMessage } from "./texts.js";

/**
 * One `push-fanout` job (mobile app spec §9.4, plan task C7): resolves the event's recipients when
 * it runs (`resolveRecipients`: membership, account status, org liveness, a pending approval or
 * question), keeps those with the event's category on, and owes one `push-deliver` per
 * registration of theirs, rendered in the registration's locale, under
 * `push-<eventId>-<registrationId>`. A repeat owes nothing new: a pending row of the same id is
 * skipped and BullMQ swallows an id it already holds (finished jobs are kept a day). Without
 * `http.publicUrl` there is no origin for the app to match a profile with, so nothing is owed.
 */
@Injectable()
export class PushFanout {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "addMany">,
    @Inject(PushRegistrationsService)
    private readonly registrations: Pick<PushRegistrationsService, "forAccounts">,
    @Inject(PushPreferencesService)
    private readonly preferences: Pick<PushPreferencesService, "enabledFor">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** Owes the deliveries of one event; returns how many outbox rows it wrote. */
  @Transactional()
  async run(data: PushFanoutData): Promise<number> {
    const cfg = this.config.get();
    const publicUrl = cfg.http.publicUrl;
    if (publicUrl === undefined) {
      this.log.warn("push fanout skipped: http.publicUrl is not set", { eventId: data.eventId });
      return 0;
    }
    const origin = new URL(publicUrl).origin;
    const resolved = await resolveRecipients(this.kdb.db, data.source);
    if (resolved === null) return 0;
    const enabled = await this.preferences.enabledFor(resolved.accountIds, resolved.category);
    if (enabled.size === 0) return 0;
    const regs = await this.registrations.forAccounts([...enabled]);
    const push = { ...resolved, eventId: data.eventId };
    const jobs: OutboxJob<PushDeliverData>[] = regs.map((reg) => ({
      queue: PUSH_QUEUE,
      name: PUSH_DELIVER_JOB,
      jobId: pushDeliverJobId(data.eventId, reg.id),
      data: {
        eventId: data.eventId,
        registrationId: reg.id,
        accountId: reg.account_id,
        message: renderPushMessage(push, reg.locale, cfg.push.previews, origin),
      },
      orgId: resolved.orgId,
    }));
    if (jobs.length === 0) return 0;
    return this.outbox.addMany(jobs);
  }
}
