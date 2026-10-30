import { Injectable } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";

/** A consumer decorated by calling the decorator, not with `@`. */
@Injectable()
export class DirectProcessor extends WorkerHost {
  async process() {}
}
Processor("direct")(DirectProcessor);

/** A cron decorated by calling the method decorator on the prototype. */
@Injectable()
export class DirectCron {
  lockService!: unknown;
  log!: unknown;
  async tick() {}
}
LockedCron("* * * * *", { name: "direct" })(
  DirectCron.prototype,
  "tick",
  Object.getOwnPropertyDescriptor(DirectCron.prototype, "tick") as PropertyDescriptor,
);
