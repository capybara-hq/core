import { type CanActivate, Controller, Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";

@Injectable()
export class OrgsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    private readonly log: Logger, // expect: kc-inject
    @InjectQueue("cap-kernel-runs") readonly queue: Queue,
  ) {}
}

@Controller("orgs")
export class OrgsController {
  constructor(orgs: OrgsService) {} // expect: kc-inject
}

export class OrgGuard implements CanActivate {
  constructor(private readonly orgs: OrgsService) {} // expect: kc-inject
  canActivate(): boolean {
    return true;
  }
}

export class PlainHelper {
  constructor(private readonly n: number) {}
}
