import { Controller, Delete, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, SuperAdmin } from "../identity/principal.js";
import { writeActorOf } from "../identity/write-actor.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam } from "../infra/validation/zod-params.js";
import { OutboxDeadParams } from "./outbox-dead.schemas.js";
import {
  type OutboxDeadRow,
  OutboxDeadService,
  type OutboxRetryOutcome,
} from "./outbox-dead.service.js";

class OutboxDeadParamsDto extends createZodDto(OutboxDeadParams, "OutboxDeadParams") {}

/**
 * Dead outbox rows (`/api/v1/admin/outbox/dead*`, transactional outbox spec §3.4): background work
 * the kernel could not queue after its last attempt. Super admins only; service tokens 403. Retry
 * and discard are audited (`outbox.retried`, `outbox.discarded`); the list is not (decision D5).
 */
@Controller("api/v1/admin/outbox/dead")
@SuperAdmin()
export class OutboxDeadController {
  constructor(@Inject(OutboxDeadService) private readonly dead: OutboxDeadService) {}

  /** The dead rows, oldest first (at most 200). */
  @Get()
  list(): Promise<{ items: OutboxDeadRow[] }> {
    return this.dead.list();
  }

  /** Makes the row due again, or discards it when the same job is owed already (`already_owed`). */
  @Post(":id/retry")
  @HttpCode(200)
  retry(
    @CurrentPrincipal() principal: Principal,
    @ZParam(OutboxDeadParamsDto) { id }: z.infer<typeof OutboxDeadParams>,
  ): Promise<{ outcome: OutboxRetryOutcome }> {
    return this.dead.retry(id, writeActorOf(principal));
  }

  /** Deletes the row: its job is never delivered. */
  @Delete(":id")
  @HttpCode(204)
  async discard(
    @CurrentPrincipal() principal: Principal,
    @ZParam(OutboxDeadParamsDto) { id }: z.infer<typeof OutboxDeadParams>,
  ): Promise<void> {
    await this.dead.discard(id, writeActorOf(principal));
  }
}
