import { Controller, Get } from "@nestjs/common";

@Controller("api/v1/orgs/:orgId/automations")
export class AutomationsController {
  @Get()
  list() {}
}
