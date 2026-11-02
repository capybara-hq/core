/** The clock time of an event in a conversation ("14:05"): the stop and approval stamps. */
export const shortTime = (iso: string, locale: string): string =>
  new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
