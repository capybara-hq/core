// model-fake stays in core: allowed. slack is an official plugin: core tests may not load it,
// except in boot.test.ts, which the test lists as an exception.
export const MODEL_FAKE = new URL("../../../plugins/model-fake/src/index.ts", import.meta.url);
export const SLACK = new URL("../../../plugins/slack/src/index.ts", import.meta.url); // MARK slack
