import { Injectable as Inj } from "@nestjs/common";
import { Processor as P, WorkerHost } from "@nestjs/bullmq";
import { LockedCron as LC } from "../infra/schedule/locked-cron.decorator.js";

@Inj()
export class AliasedJob {
  lockService!: unknown;
  log!: unknown;
  @LC("* * * * *", { name: "aliased" })
  async tick() {}
}

@Inj()
export class NsJob {
  lockService!: unknown;
  log!: unknown;
  @LC("* * * * *", { name: "ns" })
  async tick() {}
}

/** A cron through an aliased decorator import, provided by ApiModule. */
@Inj()
export class AliasCronJob {
  lockService!: unknown;
  log!: unknown;
  @LC("* * * * *", { name: "alias-cron" })
  async tick() {}
}

/** A consumer through an aliased `@Processor`, provided by ApiModule. */
@P("aliased")
export class AliasProcessor extends WorkerHost {
  async process() {}
}
