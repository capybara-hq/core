import { UI_SLOTS, type UiSlotSpec } from "@capybara-hq/plugin-sdk";
import { Controller, Get } from "@nestjs/common";

/**
 * The slot catalog (UI slots spec §3): every slot an extension can contribute to, verbatim from
 * the SDK. Static, so any signed-in person may read it; no org is involved.
 */
@Controller("api/v1/ui")
export class SlotsController {
  /** `GET /api/v1/ui/slots` → `{ slots }`. */
  @Get("slots")
  slots(): { slots: readonly UiSlotSpec[] } {
    return { slots: UI_SLOTS };
  }
}
