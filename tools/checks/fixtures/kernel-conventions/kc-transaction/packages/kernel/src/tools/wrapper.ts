import { Injectable } from "@nestjs/common";
import { Transactional } from "../infra/database/transactional.decorator.js";

@Injectable()
export class Service {
  readonly txHost = {};

  /** A callback transaction: `db.transaction().execute(fn)` under another name. */
  @Transactional()
  private async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn(); // expect: kc-transaction
  }

  @Transactional({ propagation: "requires_new" })
  async run(work: () => Promise<void>): Promise<void> {
    await work(); // expect: kc-transaction
  }

  /** A named transactional method that also calls a callback it was given: fine. */
  @Transactional()
  async save(id: string, onSaved: (id: string) => void): Promise<void> {
    await Promise.resolve(id);
    onSaved(id);
  }
}
