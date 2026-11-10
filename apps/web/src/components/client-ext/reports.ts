// Crash and load reports of client extensions (client extensions spec §10.4): at most one per
// document per (plugin, build, contribution, kind), fire and forget. A failing report (the route
// missing, the throttle, the network) is dropped silently: it never affects the page.
import {
  type ClientReport,
  type ClientReportScope,
  postClientReport,
  REPORT_MESSAGE_MAX,
} from "../../lib/client-extensions";

/** The message a report carries: the error's message only, never its stack. */
export function reportMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return String(error);
            } catch {
              return "unknown error";
            }
          })();
  return (raw === "" ? "unknown error" : raw).slice(0, REPORT_MESSAGE_MAX);
}

/** A reporter for one document; `send` is the transport (the report route by default). */
export function createReporter(
  scope: ClientReportScope | null,
  send: (scope: ClientReportScope, r: ClientReport) => Promise<unknown> = postClientReport,
) {
  const sent = new Set<string>();
  return (r: ClientReport): void => {
    if (scope === null) return;
    const key = JSON.stringify([r.plugin, r.build, r.contribution, r.kind]);
    if (sent.has(key)) return;
    sent.add(key);
    try {
      send(scope, { ...r, message: r.message.slice(0, REPORT_MESSAGE_MAX) }).catch(() => {});
    } catch {
      // a transport that throws synchronously is dropped the same way
    }
  };
}
