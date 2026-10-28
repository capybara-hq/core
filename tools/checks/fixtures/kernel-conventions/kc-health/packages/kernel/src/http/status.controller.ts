import { Controller, Get } from "@nestjs/common";

@Controller()
export class StatusController {
  @Get("healthz") // expect: kc-health
  healthz() {}
}

export function register(app: { get(path: string, h: () => void): void }) {
  app.get("/readyz", () => {}); // expect: kc-health
}
