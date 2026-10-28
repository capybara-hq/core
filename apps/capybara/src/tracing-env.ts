/**
 * Whether tracing is on: an OTLP endpoint is set (`OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and `OTEL_SDK_DISABLED` is not `true`. Standard OTel
 * variables only: tracing starts before the kernel config is read.
 */
export function tracingEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return false;
  const set = (v: string | undefined) => v !== undefined && v.trim() !== "";
  return set(env.OTEL_EXPORTER_OTLP_ENDPOINT) || set(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}
