import { readFileSync } from "node:fs";

/** The version of this package (src/ and dist/ both sit one level below package.json). */
export const PROGRAM_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
