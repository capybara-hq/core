import { Controller, Get } from "@nestjs/common";

@Controller("api/v1/orgs/:orgId/schedules")
export class SchedulesController {
  @Get()
  list() {}
}
