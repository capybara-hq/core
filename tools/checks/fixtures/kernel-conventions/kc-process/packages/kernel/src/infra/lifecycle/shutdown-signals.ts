export function handleShutdownSignals(stop: () => void) {
  process.once("SIGTERM", stop);
}
