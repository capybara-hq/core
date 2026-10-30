import { Injectable } from "@nestjs/common";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";

// a default export can be imported under any name: its module cannot be confirmed statically
@Injectable()
export default class DefaultJob { // expect: kc-worker-only
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "default" })
  async tick() {}
}
