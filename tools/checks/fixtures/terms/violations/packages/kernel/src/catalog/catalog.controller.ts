import { Controller, Get } from "@nestjs/common";

@Controller("api/v1/admin/catalogs")
export class MarketplacesController {
  @Get()
  list() {}
}
