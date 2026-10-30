import { Processor, type WorkerHost } from "@nestjs/bullmq";
import type { ClassProvider, Type } from "@nestjs/common";
import type { WorkerOptions } from "bullmq";

/** The BullMQ worker options a configured processor takes (connection and prefix come from the queue). */
export type ProcessorWorkerOptions = Omit<
  WorkerOptions,
  "connection" | "autorun" | "prefix" | "sharedConnection"
>;

/**
 * A `@Processor(queue)` provider whose worker options come from the application's startup config
 * (`@Processor` reads them from class metadata when the worker is built, at module init, so they
 * cannot be read from an injected service). Returns `{ provide: base, useClass }` with a subclass
 * of `base` decorated for this application only, so two applications in one process (tests, the
 * dual-replica harness) each get their own options. `base` is an `@Injectable` `WorkerHost` without
 * `@Processor` of its own; inject it by `base`.
 *
 * The worker never starts by itself (`autorun: false`): the role that consumes calls
 * `worker.run()` once the start sequence reached it (the kernel's worker role, after the extension
 * load), and pauses it on stop.
 */
export function configuredProcessor<T extends WorkerHost>(
  base: Type<T>,
  queue: string,
  options: ProcessorWorkerOptions,
): ClassProvider<T> {
  if (queue.includes(":")) throw new Error(`queue name "${queue}" must not contain ":"`);
  // `base` implements `process`; the cast only lets an anonymous subclass extend the abstract type
  const Configured = class extends (base as unknown as Type<object>) {};
  Object.defineProperty(Configured, "name", { value: base.name });
  Processor(queue, { ...options, autorun: false })(Configured);
  return { provide: base, useClass: Configured as unknown as Type<T> };
}
