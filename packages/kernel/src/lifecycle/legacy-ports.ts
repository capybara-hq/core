import { Global, Injectable, Module } from "@nestjs/common";
import type { RunControl } from "../conversations/conversations.service.js";
import type { OffboardingRunControl } from "../orgs/offboarding.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import type { SandboxService } from "../sandbox/sandbox.service.js";
import type { SubagentDispatch } from "../tools/pipeline.js";

/** The legacy-graph instances converted providers may still need (one field per owning task). */
export interface LegacyPortValues {
  /** runtime/providers.ts (Task 3.6b). */
  providers: ProviderRegistry;
  /**
   * The conversations' run control (RunQueue, Waits, RunAbort: Task 3.6b): start, abort a waiting
   * or orphaned run, request an abort.
   */
  runs: RunControl;
  /** The run control offboarding stops runs with (waits, run queue, abort: Task 3.6b). */
  offboardRuns: OffboardingRunControl;
  /** Sandbox destruction after offboarding (sandbox/lifecycle.ts, Task 3.8). */
  sandboxDestroy: { destroy(conversationIds: string[]): Promise<void> };
  /** sandbox/sandbox.service.ts (Task 3.8): the builtin sandbox and skill tools run in it. */
  sandbox: SandboxService;
  /**
   * The `agent` tool's dispatch (runtime/subagents/dispatch.ts over the run queue, Task 3.6b): the
   * tool pipeline dispatches sub-agents through it.
   */
  subagentDispatch: SubagentDispatch;
}

/**
 * Temporary (ruling R7; Task 3.9 deletes it with the legacy graph): the bridge from converted
 * providers to the instances the legacy graph still builds. It has no dependencies; the
 * `LEGACY_GRAPH` factory binds the legacy instances at init, before anything is served, and
 * converted providers read a port at call time (`this.ports.providers`), never in a constructor.
 * A task that converts the owner of a port replaces every read of it with a direct `@Inject` and
 * deletes the field.
 */
@Injectable()
export class LegacyPorts {
  private values: LegacyPortValues | undefined;

  /** Called once by the `LEGACY_GRAPH` factory. */
  bind(values: LegacyPortValues): void {
    if (this.values) throw new Error("LegacyPorts are already bound");
    this.values = values;
  }

  private get<K extends keyof LegacyPortValues>(key: K): LegacyPortValues[K] {
    if (!this.values) {
      throw new Error(
        `LegacyPorts.${key} read before the legacy graph was built (read ports at call time, not in a constructor)`,
      );
    }
    return this.values[key];
  }

  get providers(): ProviderRegistry {
    return this.get("providers");
  }

  get runs(): RunControl {
    return this.get("runs");
  }

  get offboardRuns(): OffboardingRunControl {
    return this.get("offboardRuns");
  }

  get sandboxDestroy(): LegacyPortValues["sandboxDestroy"] {
    return this.get("sandboxDestroy");
  }

  get sandbox(): SandboxService {
    return this.get("sandbox");
  }

  get subagentDispatch(): SubagentDispatch {
    return this.get("subagentDispatch");
  }
}

/** Global until Task 3.9 deletes it: every converted module reads the ports. */
@Global()
@Module({ providers: [LegacyPorts], exports: [LegacyPorts] })
export class LegacyPortsModule {}
