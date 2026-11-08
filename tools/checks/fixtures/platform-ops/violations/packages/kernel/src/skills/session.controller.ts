@Controller("api/v1/orgs/:orgId/sessions")
@OrgAction("skills.read")
export class SessionController {
  // platform-op-session-only: a session-only route mirrored by an operation
  @Post("mirrored")
  @SessionOnly()
  mirrored() {}

  // platform-op-session-only: a session-only route excluded as internal, not human-only / secret
  @Post("internal")
  @SessionOnly()
  internal() {}

  // fine: excluded as human-only
  @Post("human")
  @SessionOnly()
  human() {}

  // fine: excluded as secret
  @Get("secret")
  @SessionOnly()
  secret() {}
}
