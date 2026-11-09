import { UI_SLOTS } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";

/** UI operations of the `Platform` tool (UI slots spec §3): the slot catalog. */
@Injectable()
export class UiOperations implements OnModuleInit {
  constructor(@Inject(PlatformOperations) private readonly registry: PlatformOperations) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "ui.slots",
        description:
          "List the UI slots an extension can contribute to (id, version, where it is, scope and args, accepted kinds view / embed / component, cardinality list or single, minimum role, anchors). Use a slot id as a ui contribution's `slot` in a plugin manifest.",
        input: z.object({}).strict(),
        example: {},
        // any signed-in person may call the route; every run's actor is a member of this org
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/ui/slots"],
        confirm: "read",
        run: async () => ({ slots: UI_SLOTS }),
      }),
    ]);
  }
}
