import { Cron } from "@nestjs/schedule";

export class Probe {
  @Cron("* * * * *")
  tick() {}
}
