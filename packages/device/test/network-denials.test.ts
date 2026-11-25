import { describe, expect, it } from "vitest";
import { networkBlocked, parseNetworkDenial } from "../src/exec/network-denials.js";

// The lines are the patched @anthropic-ai/sandbox-runtime 0.0.81 proxy's `recordOutboundDeny`
// output, as the macOS worker reads them from the runtime's violation store.
describe("operation proxy refusals", () => {
  it("parses a refusal line: host (IPv6 bracketed), port and reason", () => {
    expect(
      parseNetworkDenial(
        "deny network-outbound capybara.meta1.top:443 (resolved to a private address)",
      ),
    ).toEqual({ host: "capybara.meta1.top", port: 443, reason: "resolved to a private address" });
    expect(
      parseNetworkDenial("deny network-outbound [::1]:8080 (address is a loopback address)"),
    ).toEqual({ host: "[::1]", port: 8080, reason: "address is a loopback address" });
    // the SOCKS side writes IPv6 bare
    expect(parseNetworkDenial("deny network-outbound fd12:3456::1:80 (address is x)")?.host).toBe(
      "[fd12:3456::1]",
    );
    expect(parseNetworkDenial("deny network-outbound Example.ORG.:443 (x)")?.host).toBe(
      "example.org",
    );
    expect(parseNetworkDenial("deny http-request GET http://a/ (x)")).toBeUndefined();
    expect(parseNetworkDenial("deny network-outbound nope (x)")).toBeUndefined();
    expect(parseNetworkDenial("deny network-outbound a.example:0 (x)")).toBeUndefined();
  });

  it("reports a private-resolving name and closed literals as address, an off-list host as device", () => {
    expect(
      networkBlocked([
        "deny network-outbound capybara.meta1.top:443 (resolved to a private address)",
        "deny network-outbound 10.0.0.1:80 (address is a private address)",
        "deny network-outbound example.org:443 (host is not on the allow list)",
        "deny socks-tunnel x.example:443 (refuseOpaqueTunnels)",
        "deny network-outbound odd.example:443 (resolved by a fake-IP resolver and the DNS-over-HTTPS lookup failed (timed out))",
      ]),
    ).toEqual([
      { host: "capybara.meta1.top", port: 443, layer: "address" },
      { host: "10.0.0.1", port: 80, layer: "address" },
      { host: "example.org", port: 443, layer: "device" },
      { host: "odd.example", port: 443, layer: "unknown" },
    ]);
  });

  it("never reports an invalid allowlist name as device, and an address refusal of a host holds", () => {
    expect(
      networkBlocked([
        // a single label or an IP literal is never grantable, whatever the reason says
        "deny network-outbound intranet:443 (host is not on the allow list)",
        "deny network-outbound 203.0.113.9:443 (host is not on the allow list)",
        // the same host refused first off-list, then for its address: address
        "deny network-outbound a.example.org:443 (host is not on the allow list)",
        "deny network-outbound a.example.org:80 (resolved to a private address)",
        42,
        `deny network-outbound long.example.org:443 (${"x".repeat(2000)})`,
      ]),
    ).toEqual([
      { host: "intranet", port: 443, layer: "address" },
      { host: "203.0.113.9", port: 443, layer: "address" },
      { host: "a.example.org", port: 443, layer: "address" },
    ]);
  });

  it("reports at most 20 hosts", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `deny network-outbound h${i}.example.org:443 (host is not on the allow list)`,
    );
    expect(networkBlocked(lines)).toHaveLength(20);
  });
});
