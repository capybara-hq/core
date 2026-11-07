import { z } from "zod";

/** Whether `tz` is an IANA time zone this runtime knows (run context spec §3.3, §3.4). */
export function isTimeZone(tz: string): boolean {
  if (tz === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name, checked with `Intl.DateTimeFormat`. */
export const IanaTimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, "must be an IANA time zone name, such as Asia/Shanghai");
