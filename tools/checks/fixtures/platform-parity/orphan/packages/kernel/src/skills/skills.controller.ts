@Controller("api/v1/orgs/:orgId/skills")
export class SkillsController {
  @Get()
  @OrgAction("skills.read")
  list() {}
}
