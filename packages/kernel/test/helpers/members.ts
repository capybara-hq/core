import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { Offboarding } from "../../src/orgs/offboarding.js";
import { membersFor, testOffboarding } from "./identity.js";

/**
 * 只依赖 db 的离职处理（测试用）：删凭据、吊销会话与令牌、转交 agent，但不取消审批 / 提问、不中止运行、
 * 不写 Redis 标记。需要完整行为的测试用 `Kernel.identity.offboarding`。
 */
export function dbOnlyOffboarding(db: KernelSchemaDb): Offboarding {
  return testOffboarding(db);
}

/** 测试用的成员服务（离职处理见 {@link dbOnlyOffboarding}）。 */
export function testMembers(db: KernelSchemaDb): MembersService {
  return membersFor(db);
}
