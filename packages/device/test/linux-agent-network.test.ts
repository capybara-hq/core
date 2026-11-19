import { spawnSync } from "node:child_process";
import { ADDRESS_CLASS_RANGES, classifyAddress } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { LINUX_DEVICE_AGENT } from "../src/exec/linux-agent.js";

// The Linux forwarder decides every open-network connection with its own Python copy of the SDK's
// address-class table (approval-only profiles design, "Open network"). These tests keep the copy
// and its lookup identical to the SDK's, so the classes cannot drift between the two languages.

const TABLE_START = "ADDRESS_CLASS_RANGES = json.loads(r'''";
const BLOCK_START = "# ---- address classes";
const BLOCK_END = "# ---- end of address classes";

/** The agent's source from the line after the one holding start up to end. */
function between(text: string, start: string, end: string): string {
  const at = text.indexOf(start);
  const from = text.indexOf("\n", at);
  const to = text.indexOf(end, from);
  if (at < 0 || from < 0 || to < 0)
    throw new Error(`the agent has no block between ${start} and ${end}`);
  return text.slice(from + 1, to);
}

const v4 = (value: bigint) =>
  [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join(".");
const v6 = (value: bigint) =>
  Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
  ).join(":");

/** Each range's first and last address and the addresses just outside it, plus seeded samples. */
function corpus(): string[] {
  const out = new Set<string>();
  for (const range of ADDRESS_CLASS_RANGES) {
    const [address = "", prefixText = ""] = range.cidr.split("/");
    const bits = range.family === "ipv4" ? 32 : 128;
    const prefix = BigInt(prefixText);
    const max = (1n << BigInt(bits)) - 1n;
    let network = 0n;
    if (range.family === "ipv4")
      for (const octet of address.split(".")) network = network * 256n + BigInt(octet);
    else network = BigInt(`0x${expand(address)}`);
    const size = 1n << (BigInt(bits) - prefix);
    const format = range.family === "ipv4" ? v4 : v6;
    for (const value of [network - 1n, network, network + 1n, network + size - 1n, network + size])
      if (value >= 0n && value <= max) out.add(format(value));
    // an embedded range also classifies through its IPv4 address: walk a few of each class
    if ("embeddedIpv4At" in range)
      for (const inner of ADDRESS_CLASS_RANGES)
        if (inner.family === "ipv4") {
          const [a = ""] = inner.cidr.split("/");
          let value = 0n;
          for (const octet of a.split(".")) value = value * 256n + BigInt(octet);
          out.add(format(network | (value << BigInt(128 - 32 - range.embeddedIpv4At))));
        }
  }
  // deterministic pseudo-random samples (xorshift), across the whole spaces and the special ones
  let state = 0x2545f4914f6cdd1dn;
  const next = () => {
    state ^= (state << 13n) & 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= (state << 17n) & 0xffffffffffffffffn;
    return state;
  };
  for (let i = 0; i < 1500; i++) {
    out.add(v4(next() & 0xffffffffn));
    const low = (next() << 64n) | next();
    out.add(v6(low));
    out.add(v6((0xffffn << 32n) | (next() & 0xffffffffn))); // v4-mapped
    out.add(v6((0x2002n << 112n) | (low & ((1n << 112n) - 1n)))); // 6to4
    out.add(v6((0x64ff9bn << 96n) | (next() & 0xffffffffn))); // NAT64
    out.add(v6(next() & 0xffffffffn)); // v4-compatible
  }
  for (const literal of [
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "fe80::1%eth0",
    "64:ff9b::8.8.8.8",
  ])
    out.add(literal);
  return [...out];
}

function expand(address: string): string {
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((g) => g.padStart(4, "0")).join("");
}

const python = spawnSync("python3", ["--version"]).status === 0;

describe("Linux forwarder address classes", () => {
  it("copies the SDK's address-class table exactly", () => {
    const copy = JSON.parse(between(LINUX_DEVICE_AGENT, TABLE_START, "'''")) as unknown;
    expect(copy).toEqual(JSON.parse(JSON.stringify(ADDRESS_CLASS_RANGES)));
  });

  // python3 is a prerequisite of the device's Linux runtime; CI's Linux runners have it
  it.runIf(python)("classifies every address as the SDK's classifyAddress does", () => {
    const addresses = corpus();
    const program = `import ipaddress, json, sys\n${between(LINUX_DEVICE_AGENT, BLOCK_START, BLOCK_END)}\nprint(json.dumps([classify_address(a) for a in json.load(sys.stdin)]))\n`;
    const run = spawnSync("python3", ["-I", "-c", program], {
      input: JSON.stringify(addresses),
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    expect(run.status, run.stderr).toBe(0);
    const classes = JSON.parse(run.stdout) as string[];
    const mismatches = addresses
      .map((address, i) => ({ address, python: classes[i], sdk: classifyAddress(address) }))
      .filter((m) => m.python !== m.sdk);
    expect(mismatches).toEqual([]);
    expect(addresses.length).toBeGreaterThan(5000);
  });
});
