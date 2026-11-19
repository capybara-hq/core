import { spawnSync } from "node:child_process";
import {
  ADDRESS_CLASS_RANGES,
  classifyAddress,
  SANDBOX_FAKE_IP_DNS,
} from "@capybara-hq/plugin-sdk";
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

const RESOLUTION_START = "# ---- resolution";
const RESOLUTION_END = "# ---- end of resolution";

/** Runs a Python program after the agent's address-class and resolution blocks; returns its JSON. */
function withResolution(program: string): unknown {
  const source = [
    "import base64, errno, http.client, ipaddress, json, socket, ssl, struct, sys, threading, time",
    "import urllib.parse",
    between(LINUX_DEVICE_AGENT, BLOCK_START, BLOCK_END),
    between(LINUX_DEVICE_AGENT, RESOLUTION_START, RESOLUTION_END),
    program,
  ].join("\n");
  const run = spawnSync("python3", ["-I", "-c", source], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}

// A DNS answer in wire format for the name, with compression pointers, as a DoH server sends it.
const ANSWER = String.raw`
def answer(name, qtype, records, rcode=0):
    labels = b"".join(bytes([len(l)]) + l.encode() for l in name.split(".")) + b"\0"
    out = struct.pack(">HHHHHH", 0, 0x8180 | rcode, 1, len(records), 0, 0) + labels
    out += struct.pack(">HH", qtype, 1)
    for rtype, ttl, address in records:
        data = ipaddress.ip_address(address).packed
        out += b"\xc0\x0c" + struct.pack(">HHIH", rtype, 1, ttl, len(data)) + data
    return out
`;

describe("Linux forwarder fake-IP resolvers", () => {
  it("uses the SDK's endpoints, timeout and cache cap", () => {
    expect(withResolution("print(json.dumps(FAKE_IP_DNS))")).toEqual(
      JSON.parse(JSON.stringify(SANDBOX_FAKE_IP_DNS)),
    );
  });

  it.runIf(python)("re-resolves a fake-IP answer through DoH and checks the real address", () => {
    const out = withResolution(String.raw`
class Doh:
    def __init__(self, answers):
        self.answers, self.asked = answers, []
    def resolve(self, name):
        self.asked.append(name)
        if isinstance(self.answers, Exception):
            raise self.answers
        return self.answers
def system(addresses):
    return lambda host, port, *a: [(socket.AF_INET6 if ":" in x else socket.AF_INET,
                                    socket.SOCK_STREAM, 6, "", (x, port)) for x in addresses]
def attempt(addresses, doh):
    try:
        found = vetted_addresses("example.test", 443, doh, resolve=system(addresses))
        return {"dialled": [c[4][0] for c in found], "asked": doh.asked}
    except PermissionError as error:
        return {"refused": type(error).__name__, "message": str(error), "asked": doh.asked}
print(json.dumps({
    "fake": attempt(["198.18.0.7"], Doh(["8.8.8.8", "2606:4700::1111"])),
    "mixed": attempt(["198.19.3.4", "9.9.9.9"], Doh(["8.8.4.4"])),
    "private": attempt(["198.18.0.7"], Doh(["10.0.0.1"])),
    "metadata": attempt(["198.18.0.7"], Doh(["169.254.169.254"])),
    "fakeAgain": attempt(["198.18.0.7"], Doh(["198.18.0.9"])),
    "failed": attempt(["198.18.0.7"], Doh(OSError(errno.ETIMEDOUT, "timed out"))),
    "plain": attempt(["9.9.9.9"], Doh(["10.0.0.1"])),
    "plainPrivate": attempt(["10.0.0.1"], Doh(["8.8.8.8"])),
}))
`) as Record<string, Record<string, unknown>>;
    // the fake address is never dialled: the DoH answer, checked like any resolved address
    expect(out.fake).toEqual({
      dialled: ["8.8.8.8", "2606:4700::1111"],
      asked: ["example.test"],
    });
    expect(out.mixed).toEqual({ dialled: ["8.8.4.4"], asked: ["example.test"] });
    for (const key of ["private", "metadata", "fakeAgain"])
      expect(out[key], key).toMatchObject({ refused: "PermissionError", asked: ["example.test"] });
    expect(out.failed).toMatchObject({ refused: "FakeIpUnresolved", asked: ["example.test"] });
    expect(String(out.failed?.message)).toMatch(/fake-IP resolver/);
    // without a fake-IP answer DoH is never asked
    expect(out.plain).toEqual({ dialled: ["9.9.9.9"], asked: [] });
    expect(out.plainPrivate).toMatchObject({ refused: "PermissionError", asked: [] });
  });

  it.runIf(python)("closes the extra addresses it is given (a container's host)", () => {
    const out = withResolution(String.raw`
system = lambda host, port, *a: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("9.9.9.9", port)),
                                 (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]
found = vetted_addresses("example.test", 443, None, resolve=system, closed=closed_set(["9.9.9.9", "::ffff:8.8.4.4"]))
try:
    vetted_addresses("example.test", 443, None, resolve=system, closed=closed_set(["9.9.9.9", "8.8.8.8"]))
    refused = False
except PermissionError:
    refused = True
print(json.dumps({"dialled": [c[4][0] for c in found], "refused": refused,
                  "mapped": public_address("::ffff:8.8.4.4", closed_set(["8.8.4.4"]))}))
`);
    expect(out).toEqual({ dialled: ["8.8.8.8"], refused: true, mapped: false });
  });

  it.runIf(python)(
    "asks the endpoints in order within one deadline; caches complete answers",
    () => {
      const out = withResolution(String.raw`
${ANSWER}
def qtype_of(query):
    end = query.index(b"\0", 12)
    return struct.unpack(">H", query[end + 1:end + 3])[0]
now = [1000.0]
calls = []
def fetch(url, query, timeout):
    qtype = qtype_of(query)
    calls.append([url, qtype, round(timeout, 3)])
    if "1.1.1.1" in url:
        raise OSError(errno.ECONNREFUSED, "refused")          # at once: no time used
    if "1.0.0.1" in url:
        if qtype == 28:
            now[0] += timeout                                  # the AAAA query times out
            raise OSError(errno.ETIMEDOUT, "timed out")
        now[0] += 0.5
        return answer("example.test", 1, [(1, 30, "9.9.9.9")])
    if qtype == 1:
        return answer("example.test", 1, [(1, 30, "8.8.8.8"), (5, 30, "1.2.3.4")])
    return answer("example.test", 28, [(28, 100000, "2606:4700::1111")])
doh = EncryptedDns(fetch=fetch, clock=lambda: now[0])
first = doh.resolve("Example.Test.")
order = list(calls)
doh.resolve("example.test")
cached = len(calls) - len(order)
now[0] += 31
doh.resolve("example.test")
expired = len(calls) - len(order) - cached
# every endpoint slow: the whole lookup ends at the deadline
slow_now = [0.0]
slow_calls = []
def slow(url, query, timeout):
    slow_calls.append(round(timeout, 3))
    slow_now[0] += timeout
    raise OSError(errno.ETIMEDOUT, "timed out")
try:
    EncryptedDns(fetch=slow, clock=lambda: slow_now[0]).resolve("other.test")
    failure = None
except FakeIpUnresolved as error:
    failure = str(error)
# a bounded cache with a capped TTL
bounded = EncryptedDns(fetch=lambda url, q, t: answer("x.test", qtype_of(q), [(qtype_of(q), 999999, "8.8.8.8" if qtype_of(q) == 1 else "2606:4700::1")]))
for i in range(300):
    bounded.resolve("n%d.test" % i)
print(json.dumps({"first": first, "order": order, "cached": cached, "expired": expired,
                  "failure": failure, "slowTotal": round(slow_now[0], 3), "slowCalls": slow_calls,
                  "size": len(bounded.cache), "newest": "n299.test" in bounded.cache,
                  "oldest": "n0.test" in bounded.cache,
                  "ttl": bounded.cache["n299.test"][0] - time.monotonic(),
                  "query": base64.b64encode(dns_query("a.b", 28)).decode()}))
`) as Record<string, unknown>;
      const [cf1, cf2, g1, g2] = SANDBOX_FAKE_IP_DNS.endpoints;
      expect(SANDBOX_FAKE_IP_DNS.endpoints).toHaveLength(4);
      // the whole answer of one endpoint: 1.0.0.1 answered A but not AAAA, so 8.8.8.8 answered
      expect(out.first).toEqual(["8.8.8.8", "2606:4700::1111"]);
      // each endpoint gets an equal share of the time left; A and AAAA share an endpoint's share
      expect(out.order).toEqual([
        [cf1, 1, 1.25],
        [cf2, 1, 1.667],
        [cf2, 28, 1.167],
        [g1, 1, 1.667],
        [g1, 28, 1.667],
      ]);
      expect(out.cached).toBe(0);
      expect(out.expired).toBeGreaterThan(0);
      expect(String(out.failure)).toMatch(/fake-IP resolver/);
      expect(out.slowTotal).toBeLessThanOrEqual(SANDBOX_FAKE_IP_DNS.timeoutMs / 1000);
      expect((out.slowCalls as number[]).length).toBeGreaterThanOrEqual(4);
      expect(out.size).toBe(SANDBOX_FAKE_IP_DNS.cacheMaxNames);
      expect(out).toMatchObject({ newest: true, oldest: false });
      expect(out.ttl).toBeLessThanOrEqual(SANDBOX_FAKE_IP_DNS.cacheTtlCapSeconds);
      expect(out.ttl).toBeGreaterThan(SANDBOX_FAKE_IP_DNS.cacheTtlCapSeconds - 60);
      expect(g2).toBe("https://8.8.4.4/dns-query");
      // RD set, one question, a.b, AAAA, class IN
      expect(Buffer.from(String(out.query), "base64").subarray(2).toString("hex")).toBe(
        "010000010000000000000161016200001c0001",
      );
    },
  );
});
