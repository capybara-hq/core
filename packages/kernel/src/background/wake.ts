import { Injectable } from "@nestjs/common";

/**
 * Wakes an idle conversation when one of its background tasks finished (spec
 * 2026-11-05-background-bash-design §3). {@link BackgroundTaskFinisher} calls it after the finish
 * committed. A no-op until the wake lands (plan Task 6).
 */
@Injectable()
export class BackgroundWake {
  async onFinished(_conversationId: string): Promise<void> {}
}
