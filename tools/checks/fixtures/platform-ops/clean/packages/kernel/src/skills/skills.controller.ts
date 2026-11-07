@Controller("api/v1/orgs/:orgId/skills")
@OrgAction("skills.read")
export class SkillsController {
  @Get()
  list() {}

  @Get(":id")
  get() {}

  @Post("/")
  @OrgAction("skills.manage")
  create() {}

  @Delete(":id")
  @OrgAction("skills.manage")
  remove() {}

  @Get("later")
  later() {}

  @Get("export")
  exportAll() {}
}

@Controller("/api/v1/admin/")
export class AdminController {
  @Get("stats")
  @SuperAdmin()
  stats() {}
}
