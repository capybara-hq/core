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

  @Get("c")
  c() {}

  @Post("d")
  d() {}

  @Post("e")
  e() {}

  @Post("g")
  g() {}

  @Post("uploads")
  uploads() {}
}

@Controller("api/v1/orgs/:orgId/attachments")
@OrgAction("skills.read")
export class AttachmentsController {
  @Post()
  create() {}
}
