import { readFileSync } from "node:fs";
// @ts-expect-error the package is deliberately not installed: the pack must refuse it
import { chunk } from "lodash-es";

export default { chunk, readFileSync };
