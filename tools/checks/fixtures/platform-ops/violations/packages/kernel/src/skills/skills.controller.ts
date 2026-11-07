@Controller("api/v1/orgs/:orgId/skills")
@OrgAction("skills.read")
export class SkillsController {
  @Get()
  list() {}

  @Get(":id")
  get() {}

  @Post()
  @OrgAction("skills.manage")
  create() {}

  @Put(":id")
  @OrgAction("skills.manage")
  update() {}

  @Delete(":id")
  @OrgAction("skills.manage")
  remove() {}

  @Patch(":id")
  @OrgAction("skills.manage")
  patch() {}

  @Get("a")
  a() {}

  @Get("b")
  b() {}
}
