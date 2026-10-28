export function createLogger(level = "info") {
  return { level };
}
export const defaultLogger = createLogger();
