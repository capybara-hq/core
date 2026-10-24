import { Controller, Get, Post } from "@nestjs/common";

export const CATALOG_UPLOAD_ROUTE = "/api/v1/admin/catalog/import/file";

@Controller("api/v1/admin/marketplaces")
export class MarketplacesController {
  @Get()
  list() {}
}

@Controller("api/v1/orgs/:orgId")
export class OrgCatalogController {
  @Get("catalog")
  list() {}

  @Post("catalog-requests/:id/decide")
  decide() {}

  @Post("extensions/:extension/directory/sync")
  sync() {}
}
