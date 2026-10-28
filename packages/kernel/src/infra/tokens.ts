/** Injection tokens of the global infra modules. */

/** The process logger (`KernelLogger`). */
export const KERNEL_LOGGER = Symbol("KERNEL_LOGGER");

/** The startup input of `KernelConfigService`: `{ config, env }`. */
export const KERNEL_CONFIG_INPUT = Symbol("KERNEL_CONFIG_INPUT");

/** The Kysely pool, untyped (`Kysely<any>`); infra only, services inject `KernelDb`. */
export const KERNEL_POOL = Symbol("KERNEL_POOL");

/** The main ioredis connection (lazy: connects on first command or an explicit `connect()`). */
export const REDIS = Symbol("REDIS");

/** The shared bus subscriber connection (`BusSubscriber` with `close()`). */
export const REDIS_SUBSCRIBER = Symbol("REDIS_SUBSCRIBER");

/** The kernel bus (`createBus(..., "kernel")`, `ExtensionContext["bus"]`). */
export const KERNEL_BUS = Symbol("KERNEL_BUS");
