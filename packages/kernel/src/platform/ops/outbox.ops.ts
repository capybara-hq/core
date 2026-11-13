import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { OutboxDeadParams } from "../../admin/outbox-dead.schemas.js";
import { OutboxDeadService } from "../../admin/outbox-dead.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";

const DeadIdInput = OutboxDeadParams.strict();

/**
 * The super admin's dead outbox rows through the `Platform` tool (transactional outbox spec
 * §3.4): the list, retry and discard of `/api/v1/admin/outbox/dead*`, run through the same
 * service. Dead rows are the deployment's, not an org's: the operations act on all of them.
 */
@Injectable()
export class OutboxOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OutboxDeadService) private readonly dead: OutboxDeadService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The dead row's job (queue and name) for a card, or null when no dead row has the id. */
  private async jobOf(id: string): Promise<{ queue: string; job_name: string } | null> {
    const row = await this.kdb.db
      .selectFrom("outbox")
      .select(["queue", "job_name"])
      .where("id", "=", id)
      .where("dead_at", "is not", null)
      .executeTakeFirst();
    return row ?? null;
  }

  private async precheck(id: string): Promise<PrecheckResult> {
    return (await this.jobOf(id)) === null
      ? { ok: false, code: "outbox.not_found", message: `No dead outbox row ${id}.` }
      : { ok: true };
  }

  /** "job-name on queue" for a card, or the bare id when the row is gone. */
  private async label(id: string): Promise<string> {
    const job = await this.jobOf(id);
    return job === null ? `#${id}` : `${job.job_name} (${job.queue}, #${id})`;
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "admin.outbox-list-dead",
        description:
          "List background work the kernel could not queue (super admin): outbox rows dead after their last delivery attempt, oldest first (at most 200), each with its id, queue, job name, job id, org (null for platform work), attempts, last error and when it died. Retry one with admin.outbox-retry or drop it with admin.outbox-discard.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/outbox/dead"],
        confirm: "read",
        run: () => this.dead.list(),
      }),
      defineOperation({
        id: "admin.outbox-retry",
        description:
          "Queue a dead outbox row again (super admin): it gets fresh attempts and is delivered right away. When the same job is already owed by a pending row, the dead copy is discarded instead; outcome says which (retried or already_owed). A job whose subject is gone since is harmless: it finds nothing to do. The platform audit log records it.",
        input: DeadIdInput,
        example: { id: "42" },
        authz: { superAdmin: true },
        mirrors: ["POST /api/v1/admin/outbox/dead/:id/retry"],
        confirm: "platform",
        errors: [
          {
            code: "outbox.not_found",
            next: "The row is no longer dead (retried, discarded or delivered): list the dead rows again with admin.outbox-list-dead.",
          },
        ],
        precheck: (i) => this.precheck(i.id),
        summary: async (i) => {
          const job = await this.label(i.id);
          return {
            zh: `重新排入无法排入队列的后台任务 ${job}`,
            en: `Queue background work that could not be queued again: ${job}`,
          };
        },
        run: (input, ctx) =>
          this.dead.retry(
            input.id,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.outbox-retry", ctx),
          ),
      }),
      defineOperation({
        id: "admin.outbox-discard",
        description:
          "Discard a dead outbox row (super admin): its job is never run. Use it only when the work is no longer wanted; to run it, use admin.outbox-retry. The platform audit log records it.",
        input: DeadIdInput,
        example: { id: "42" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/outbox/dead/:id"],
        confirm: "platform",
        errors: [
          {
            code: "outbox.not_found",
            next: "The row is no longer dead (retried, discarded or delivered): list the dead rows again with admin.outbox-list-dead.",
          },
        ],
        precheck: (i) => this.precheck(i.id),
        summary: async (i) => {
          const job = await this.label(i.id);
          return {
            zh: `丢弃无法排入队列的后台任务 ${job}，它不会再运行`,
            en: `Discard background work that could not be queued: ${job}; it will never run`,
          };
        },
        run: async (input, ctx) => {
          await this.dead.discard(
            input.id,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.outbox-discard", ctx),
          );
          return { id: input.id, discarded: true };
        },
      }),
    ]);
  }
}
