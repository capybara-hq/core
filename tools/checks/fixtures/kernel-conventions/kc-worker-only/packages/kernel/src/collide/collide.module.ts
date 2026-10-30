import { Injectable, Module } from "@nestjs/common";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";

@Injectable()
export class AaJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "aa" })
  async tick() {}
}

@Injectable()
export class ZzJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "zz" })
  async tick() {}
}

@Injectable()
export class BbJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "bb" })
  async tick() {}
}

@Injectable()
export class YyJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "yy" })
  async tick() {}
}

@Injectable()
export class DefJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "def" })
  async tick() {}
}

// Two barrels export AaModule and ZzModule under the same alias Jobs, BbModule and YyModule under
// Kit; KernelModule imports Jobs from the first-scanned barrel and Kit from the last-scanned one.
@Module({ providers: [AaJob] }) // expect: kc-worker-only
export class AaModule {}

@Module({ providers: [ZzJob] })
export class ZzModule {}

@Module({ providers: [BbJob] })
export class BbModule {}

@Module({ providers: [YyJob] }) // expect: kc-worker-only
export class YyModule {}

// re-exported as a default and imported by KernelModule under another name
@Module({ providers: [DefJob] }) // expect: kc-worker-only
export class DefModule {}
