/** Injection tokens of the kernel application (`KernelModule`) itself. */

/**
 * The legacy service graph (`createLegacyGraph` in kernel.ts): today's hand-wired domain services,
 * one factory provider until each domain directory becomes its own module (Phase 3).
 */
export const LEGACY_GRAPH = Symbol("LEGACY_GRAPH");

/**
 * Test hooks of the legacy graph (`{ loop, runHooks, evalHooks }`), passed by the temporary
 * `createKernel` facade until Task 3.6 replaces them with provider overrides (ruling R2).
 */
export const KERNEL_TEST_HOOKS = Symbol("KERNEL_TEST_HOOKS");

/** The `KernelAppOptions` the application was built with. */
export const KERNEL_APP_OPTIONS = Symbol("KERNEL_APP_OPTIONS");
