import { describe, expect, it } from "vitest";
import { mergeServiceHosts, strongerLayer } from "../../src/tools/call-scope.js";

describe("refused-host layers of a device service's call", () => {
  it("strongerLayer keeps the more restrictive layer", () => {
    expect(strongerLayer("device", "address")).toBe("address");
    expect(strongerLayer("address", "device")).toBe("address");
    expect(strongerLayer("device", "org")).toBe("org");
    expect(strongerLayer("org", "address")).toBe("address");
    expect(strongerLayer("unknown", "device")).toBe("device");
    expect(strongerLayer("device", "unknown")).toBe("device");
  });

  it("mergeServiceHosts dedupes by host in first-seen order, never loosening a layer", () => {
    expect(
      mergeServiceHosts(
        [
          { host: "intranet.example.org", layer: "address" },
          { host: "example.org", layer: "device" },
        ],
        [
          { host: "Intranet.Example.org.", layer: "device" },
          { host: "cdn.example.org", layer: "device" },
          { host: "example.org", layer: "org" },
        ],
      ),
    ).toEqual([
      { host: "intranet.example.org", layer: "address" },
      { host: "example.org", layer: "org" },
      { host: "cdn.example.org", layer: "device" },
    ]);
  });
});
