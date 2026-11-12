export const OUTBOX_JOBS = {
  noIdempotent: { // expect: outbox-registry
    queue: "q",
    idempotent: "  ",
    processedIn: "packages/kernel/src/runtime/ok.processor.ts",
  },
  missingFile: { // expect: outbox-registry
    queue: "q",
    idempotent: "harmless",
    processedIn: "packages/kernel/src/runtime/gone.processor.ts",
  },
  noProcessor: { // expect: outbox-registry
    queue: "q",
    idempotent: "harmless",
    processedIn: "packages/kernel/src/runtime/plain.ts",
  },
  noName: { // expect: outbox-registry
    queue: "q",
    idempotent: "harmless",
    processedIn: "packages/kernel/src/runtime/ok.processor.ts",
  },
  fine: {
    queue: "q",
    idempotent: "harmless",
    processedIn: "packages/kernel/src/runtime/ok.processor.ts",
  },
} as const;
