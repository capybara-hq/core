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

@Controller("api/v1/me")
export class MeController {
  // any signed-in person: an operation may ask an org action, every run's actor is a member
  @Put("preferences")
  setPreferences() {}
}
