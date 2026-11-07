const PREFIX = "api/v1/orgs/:orgId/dyn";
const PATH = "x";

@Controller("api/v1/orgs/:orgId/dyn")
@OrgAction("skills.read")
export class DynamicController {
  // platform-op-literal: route path not a literal
  @Get(PATH)
  viaConst() {}
}

@Controller(PREFIX)
export class DynamicPrefixController {
  // platform-op-literal: controller prefix not a literal
  @Get("y")
  viaPrefix() {}
}
