import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  blockedHosts,
  classifyHost,
  denyReason,
  MAX_BLOCKED_HOSTS,
  networkTrailer,
  parseNetworkViolation,
} from "../src/network.js";

const limits = (
  egress: SandboxLimits["egress"],
  allowHosts: string[] = [],
): Pick<SandboxLimits, "egress" | "allowHosts"> => ({ egress, allowHosts });
const policy = (allowedDomains: string[], network?: "allowlist" | "open") => ({
  allowedDomains,
  ...(network !== undefined && { network }),
});

describe("parseNetworkViolation (sandbox-runtime 0.0.81 line format)", () => {
  it("parses a refused host, port and reason", () => {
    expect(
      parseNetworkViolation(
        "deny network-outbound files.slack.com:443 (host is not on the allow list)",
      ),
    ).toEqual({ host: "files.slack.com", port: 443, reason: "host is not on the allow list" });
  });

  it("parses a bracketed IPv6 host", () => {
    expect(
      parseNetworkViolation("deny network-outbound [::1]:443 (host is not on the allow list)"),
    ).toEqual({ host: "::1", port: 443, reason: "host is not on the allow list" });
  });

  it("parses a resolved-address reason and the ask callback's own reason", () => {
    expect(
      parseNetworkViolation(
        "deny network-outbound intranet.example.com:80 (resolved to a loopback address)",
      ),
    ).toEqual({ host: "intranet.example.com", port: 80, reason: "resolved to a loopback address" });
    expect(
      parseNetworkViolation(
        "deny network-outbound a.com:443 (capybara: a.com is not in this device's allowed domains)",
      )?.reason,
    ).toBe("capybara: a.com is not in this device's allowed domains");
  });

  it("ignores socks tunnel, file and malformed lines", () => {
    expect(parseNetworkViolation("deny socks-tunnel a.com:443 (blocked)")).toBeUndefined();
    expect(parseNetworkViolation("deny file-read-data /Users/x/.ssh/id_rsa")).toBeUndefined();
    expect(parseNetworkViolation("deny network-outbound a.com (no port)")).toBeUndefined();
    expect(parseNetworkViolation("")).toBeUndefined();
  });
});

describe("classifyHost", () => {
  const notListed = "host is not on the allow list";

  it("org egress none refuses at the org layer", () => {
    expect(classifyHost("a.com", notListed, limits("none"), policy(["a.com"]))).toBe("org");
  });

  it("a host outside the org allowlist is org, also when the device lacks it", () => {
    expect(classifyHost("a.com", notListed, limits("allowlist", ["b.com"]), policy([]))).toBe(
      "org",
    );
    expect(
      classifyHost("a.com", notListed, limits("allowlist", ["b.com"]), policy(["a.com"])),
    ).toBe("org");
  });

  it("a host the org allows but the device does not is device", () => {
    expect(
      classifyHost("a.com", notListed, limits("allowlist", ["a.com"]), policy(["b.com"])),
    ).toBe("device");
    expect(classifyHost("github.com", notListed, limits("open"), policy([]))).toBe("device");
    expect(
      classifyHost("api.x.com", notListed, limits("allowlist", ["*.x.com"]), policy(["x.com"])),
    ).toBe("device");
  });

  it("wildcards admit subdomains, never the apex", () => {
    expect(
      classifyHost("x.com", notListed, limits("allowlist", ["*.x.com"]), policy(["x.com"])),
    ).toBe("org");
    expect(
      classifyHost("x.com", notListed, limits("allowlist", ["x.com"]), policy(["*.x.com"])),
    ).toBe("device");
  });

  it("a device whose network is open is never the refusing layer", () => {
    expect(classifyHost("a.com", notListed, limits("open"), policy([], "open"))).toBe("unknown");
    expect(
      classifyHost("a.com", notListed, limits("allowlist", ["b.com"]), policy([], "open")),
    ).toBe("org");
  });

  it("addresses and internal names are address, whatever the lists", () => {
    expect(classifyHost("10.0.0.5", notListed, limits("open"), policy([]))).toBe("address");
    expect(classifyHost("::1", notListed, limits("open"), policy([]))).toBe("address");
    expect(classifyHost("localhost", notListed, limits("open"), policy([]))).toBe("address");
    expect(classifyHost("printer.local", notListed, limits("open"), policy([]))).toBe("address");
    expect(
      classifyHost(
        "a.com",
        "resolved to a loopback address",
        limits("allowlist", ["a.com"]),
        policy(["a.com"]),
      ),
    ).toBe("address");
  });

  it("a host both lists allow is unknown", () => {
    expect(
      classifyHost("a.com", notListed, limits("allowlist", ["a.com"]), policy(["a.com"])),
    ).toBe("unknown");
  });

  it("matching ignores case", () => {
    expect(
      classifyHost("A.com", notListed, limits("allowlist", ["a.COM"]), policy(["b.com"])),
    ).toBe("device");
  });
});

describe("blockedHosts", () => {
  const line = (host: string, port = 443) =>
    `deny network-outbound ${host}:${port} (host is not on the allow list)`;

  it("dedupes by host keeping the first port, skips other lines", () => {
    expect(
      blockedHosts(
        [
          line("a.com", 443),
          "deny file-write-create /etc/x",
          line("a.com", 80),
          line("10.0.0.5", 22),
        ],
        limits("open"),
        policy([]),
      ),
    ).toEqual([
      { host: "a.com", port: 443, layer: "device" },
      { host: "10.0.0.5", port: 22, layer: "address" },
    ]);
  });

  it("keeps at most MAX_BLOCKED_HOSTS hosts", () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(`h${i}.example.com`));
    const out = blockedHosts(lines, limits("none"), policy([]));
    expect(MAX_BLOCKED_HOSTS).toBe(20);
    expect(out).toHaveLength(20);
    expect(out[19]?.host).toBe("h19.example.com");
  });
});

describe("networkTrailer", () => {
  it("is empty without blocked hosts", () => {
    expect(networkTrailer([])).toBe("");
  });

  it("names each host, its layer and who can lift it (spec §9.2)", () => {
    expect(
      networkTrailer([
        { host: "files.slack.com", port: 443, layer: "device" },
        { host: "api.foo.com", port: 443, layer: "org" },
        { host: "10.0.0.5", port: 22, layer: "address" },
        { host: "::1", port: 443, layer: "address" },
        { host: "odd.example.com", port: 443, layer: "unknown" },
      ]),
    ).toBe(
      [
        "[capybara-device] Network access was blocked:",
        "- files.slack.com:443: not in this device's allowed domains. Only the device owner can allow it (capybara-device policy add allowedDomains files.slack.com, or the device page).",
        "- api.foo.com:443: not in the organization's network allowlist. Only an organization admin can add it.",
        "- 10.0.0.5:22: a private or local address; commands can never reach it.",
        "- [::1]:443: a private or local address; commands can never reach it.",
        "- odd.example.com:443: refused by the sandbox's network proxy.",
      ].join("\n"),
    );
  });
});

describe("denyReason (the ask callback's answer)", () => {
  it("names the device layer", () => {
    expect(denyReason("files.slack.com", limits("open"), policy([]))).toBe(
      "capybara: files.slack.com is not in this device's allowed domains",
    );
  });

  it("names the org layer", () => {
    expect(denyReason("files.slack.com", limits("allowlist", ["b.com"]), policy([]))).toBe(
      "capybara: files.slack.com is not in the organization's network allowlist",
    );
    expect(denyReason("a.com", limits("none"), policy(["a.com"]))).toBe(
      "capybara: a.com is not in the organization's network allowlist",
    );
  });

  it("names an address and falls back without limits", () => {
    expect(denyReason("10.0.0.5", limits("open"), policy([]))).toBe(
      "capybara: 10.0.0.5 is a private or local address",
    );
    expect(denyReason("a.com", undefined, policy([]))).toBe(
      "capybara: a.com is not in this device's allowed domains",
    );
    expect(denyReason("a.com", undefined, policy(["a.com"]))).toBe(
      "capybara: a.com is not allowed by the network policy",
    );
  });
});
