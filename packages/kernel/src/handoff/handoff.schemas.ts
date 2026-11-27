import { z } from "zod";

/** `POST /api/v1/auth/handoffs/redeem`: the ticket from the web page's path `/handoff/<ticket>`. */
export const HandoffRedeemBodySchema = z.object({ ticket: z.string().max(100) }).strict();
export type HandoffRedeemBody = z.infer<typeof HandoffRedeemBodySchema>;

/**
 * The redeem's answer: where this browser goes next (the authorization server's or identity
 * source's authorize URL, or the handoff done page with `?error=<code>` when a link cannot start).
 */
export type HandoffRedeemResponse = { location: string };
