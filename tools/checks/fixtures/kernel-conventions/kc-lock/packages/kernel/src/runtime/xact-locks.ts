import { Injectable } from "@nestjs/common";
import { sql } from "kysely";

declare const Transactional: (o?: object) => MethodDecorator;

/** A dedicated lock provider whose mandatory method takes the transaction-scoped lock. */
@Injectable()
export class SetupLock {
  readonly txHost: unknown = undefined;

  @Transactional({ propagation: "mandatory" })
  async lock(db: unknown): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('setup'))`.execute(db as never);
  }

  @Transactional()
  async required(db: unknown): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('setup'))`.execute(db as never); // expect: kc-lock
  }

  @Transactional({ propagation: "mandatory" })
  async session(db: unknown): Promise<void> {
    await sql`SELECT pg_advisory_lock(hashtext('setup'))`.execute(db as never); // expect: kc-lock
  }
}

/** Not a lock provider: the same mandatory method is still a hand-rolled lock. */
@Injectable()
export class SetupService {
  readonly txHost: unknown = undefined;

  @Transactional({ propagation: "mandatory" })
  async lock(db: unknown): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('setup'))`.execute(db as never); // expect: kc-lock
  }
}

/** Named like one but not injectable. */
export class PlainLock {
  readonly txHost: unknown = undefined;

  @Transactional({ propagation: "mandatory" })
  async lock(db: unknown): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('setup'))`.execute(db as never); // expect: kc-lock
  }
}
