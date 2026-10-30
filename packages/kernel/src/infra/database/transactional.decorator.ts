// Ported from octok-platform libs/common/src/decorators/transactional.decorator.ts (owner-approved, 2026-10-28).
// Adapted to Kysely: the transaction comes from the `TransactionHost` injected as `this.txHost`.
import type { TransactionHost, TransactionOptions } from "./transaction-host.js";

interface WithTxHost {
  txHost?: TransactionHost;
}

/**
 * Method decorator: runs the method in a database transaction (REQUIRED by default: join the one
 * in context, else open it; a throw rolls back, a normal return commits). The class must inject
 * the host as a property named `txHost`:
 *
 * ```ts
 * constructor(@Inject(TransactionHost) readonly txHost: TransactionHost) {}
 * ```
 *
 * Use `{ propagation: "requires_new" }` for a transaction independent of the caller's, and
 * `{ propagation: "mandatory" }` for a method whose correctness depends on a lock its caller holds
 * (it joins the caller's transaction and throws when called outside one).
 */
export function Transactional(opts: TransactionOptions = {}) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function (this: WithTxHost, ...args: unknown[]) {
      const host = this.txHost;
      if (!host) {
        throw new Error(
          "@Transactional() needs the class to inject `TransactionHost` as `txHost` " +
            "(`@Inject(TransactionHost) readonly txHost: TransactionHost`).",
        );
      }
      return host.run(() => original.apply(this, args), opts);
    };
    return descriptor;
  };
}
