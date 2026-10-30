import { Injectable } from "@nestjs/common";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";

/** Crons provided behind a type assertion or parentheses. */
@Injectable()
export class AsJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "as" })
  async tick() {}
}

@Injectable()
export class AngleJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "angle" })
  async tick() {}
}

@Injectable()
export class BangJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "bang" })
  async tick() {}
}

@Injectable()
export class ParenJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "paren" })
  async tick() {}
}

@Injectable()
export class CastClassJob {
  lockService!: unknown;
  log!: unknown;
  @LockedCron("* * * * *", { name: "cast-class" })
  async tick() {}
}
