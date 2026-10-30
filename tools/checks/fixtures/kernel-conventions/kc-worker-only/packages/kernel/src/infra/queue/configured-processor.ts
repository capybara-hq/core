import { Processor, type WorkerHost } from "@nestjs/bullmq";
import type { ClassProvider, Type } from "@nestjs/common";

// the factory itself: its provider is checked where it is called, by its `base` argument
export function configuredProcessor<T extends WorkerHost>(
  base: Type<T>,
  queue: string,
  options: object,
): ClassProvider<T> {
  const Configured = class extends (base as unknown as Type<object>) {};
  Processor(queue, { ...options, autorun: false })(Configured);
  return { provide: base, useClass: Configured as unknown as Type<T> };
}
