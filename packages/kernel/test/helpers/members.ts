import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { Offboarding } from "../../src/orgs/offboarding.js";
import { membersFor, testOffboarding } from "./identity.js";

/**
 * Offboarding over the database only (tests): deletes credentials, revokes sessions and tokens and
 * hands agents over, but cancels no approval / question, aborts no run and writes no Redis marker.
 * Tests that need the full behaviour use `k.app.get(Offboarding)`.
 */
export function dbOnlyOffboarding(db: KernelSchemaDb): Offboarding {
  return testOffboarding(db);
}

/** 测试用的成员服务（离职处理见 {@link dbOnlyOffboarding}）。 */
export function testMembers(db: KernelSchemaDb): MembersService {
  return membersFor(db);
}
