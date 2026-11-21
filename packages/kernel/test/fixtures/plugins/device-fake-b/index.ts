import { defineFakeDevice } from "../device-fake/index.js";

/**
 * A second test `device-provider@1` (same behavior as `device-fake`, its own name and its own
 * deployment `root`), for tests with more than one provider.
 */
export default defineFakeDevice("device-fake-b", "Second test device");
