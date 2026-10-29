import { Global, Injectable, Module } from "@nestjs/common";
import type { AgentsService } from "../agents/agents.service.js";
import type { AttachmentsService } from "../conversations/attachments.service.js";
import type { EventLog } from "../conversations/event-log.js";
import type { OffboardingRunControl } from "../orgs/offboarding.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { ConnectorsService } from "../tools/connectors.service.js";
import type { Credentials } from "../tools/credentials.js";
import type { QuestionsService } from "../tools/questions.service.js";

/** The legacy-graph instances converted providers may still need (one field per owning task). */
export interface LegacyPortValues {
  /** conversations/event-log.ts (Task 3.6). */
  eventLog: EventLog;
  /** conversations/attachments.service.ts (Task 3.6). */
  attachments: AttachmentsService;
  /** runtime/providers.ts (Task 3.6). */
  providers: ProviderRegistry;
  /** agents/agents.service.ts (Task 3.6). */
  agents: AgentsService;
  /** tools/credentials.ts (Task 3.5): offboarding deletes the member's credentials. */
  credentials: Pick<Credentials, "clearAccount">;
  /** tools/approvals.service.ts (Task 3.5): offboarding cancels the member's approvals. */
  approvals: Pick<ApprovalsService, "cancelPendingFor">;
  /** tools/questions.service.ts (Task 3.5): offboarding cancels the member's questions. */
  questions: Pick<QuestionsService, "cancelPendingFor">;
  /** The run control offboarding stops runs with (waits, run queue, abort: Task 3.6). */
  offboardRuns: OffboardingRunControl;
  /** Sandbox destruction after offboarding (sandbox/lifecycle.ts, Task 3.8). */
  sandboxDestroy: { destroy(conversationIds: string[]): Promise<void> };
  /** tools/connectors.service.ts (Task 3.5): org plugin installs create, update and remove connectors. */
  connectors: ConnectorsService;
}

/**
 * Temporary (ruling R7; Task 3.9 deletes it with the legacy graph): the bridge from converted
 * providers to the instances the legacy graph still builds. It has no dependencies; the
 * `LEGACY_GRAPH` factory binds the legacy instances at init, before anything is served, and
 * converted providers read a port at call time (`this.ports.eventLog`), never in a constructor.
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

  get eventLog(): EventLog {
    return this.get("eventLog");
  }

  get attachments(): AttachmentsService {
    return this.get("attachments");
  }

  get providers(): ProviderRegistry {
    return this.get("providers");
  }

  get agents(): AgentsService {
    return this.get("agents");
  }

  get credentials(): LegacyPortValues["credentials"] {
    return this.get("credentials");
  }

  get approvals(): LegacyPortValues["approvals"] {
    return this.get("approvals");
  }

  get questions(): LegacyPortValues["questions"] {
    return this.get("questions");
  }

  get offboardRuns(): OffboardingRunControl {
    return this.get("offboardRuns");
  }

  get sandboxDestroy(): LegacyPortValues["sandboxDestroy"] {
    return this.get("sandboxDestroy");
  }

  get connectors(): ConnectorsService {
    return this.get("connectors");
  }
}

/** Global until Task 3.9 deletes it: every converted module reads the ports. */
@Global()
@Module({ providers: [LegacyPorts], exports: [LegacyPorts] })
export class LegacyPortsModule {}
