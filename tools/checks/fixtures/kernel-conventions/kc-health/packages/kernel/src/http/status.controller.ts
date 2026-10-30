import { Controller, Get } from "@nestjs/common";
import { READY } from "./paths.js";

const path = "healthz";
const PATHS = { ready: "/readyz" };
declare function route(name: string): string;

@Controller()
export class StatusController {
  @Get("healthz") // expect: kc-health
  healthz() {}

  @Get(path) // expect: kc-health
  held() {}

  @Get(READY) // expect: kc-health
  imported() {}

  @Get(PATHS.ready) // expect: kc-health
  member() {}

  @Get(route("status")) // expect: kc-health
  computed() {}

  @Get("status")
  status() {}

  @Get()
  index() {}
}

@Controller(path) // expect: kc-health
export class PrefixController {}

export function register(app: { get(path: string, h: () => void): void }) {
  app.get("/readyz", () => {}); // expect: kc-health
  app.get(READY, () => {}); // expect: kc-health
}
