@Controller()
export class HealthController {
  @Get("healthz")
  healthz() {}
}
