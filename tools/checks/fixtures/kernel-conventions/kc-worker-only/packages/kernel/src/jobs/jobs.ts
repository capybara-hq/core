import { Injectable } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";

@Injectable()
export class ScheduledJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "scheduled" })
  async tick() {}
}

@Injectable()
export class NestedJob {
  lockService!: unknown;
  log!: unknown;
  config!: unknown;
  @LockedInterval("nested", () => 1000)
  async tick() {}
}

@Injectable()
export class SharedJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "shared" })
  async tick() {}
}

@Injectable()
export class ApiJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "api" })
  async tick() {}
}

@Injectable()
export class LooseJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "loose" })
  async tick() {}
}

@Injectable()
export class CycleJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "cycle" })
  async tick() {}
}

/** A base class: `configuredProcessor` decorates a subclass of it with `@Processor`. */
@Injectable()
export class QueueProcessor extends WorkerHost {
  async process() {}
}

@Injectable()
export class ApiProcessor extends WorkerHost {
  async process() {}
}

@Processor("decorated")
export class DecoratedProcessor extends WorkerHost {
  async process() {}
}

/** Not a job: listed anywhere. */
@Injectable()
export class PlainService {}
