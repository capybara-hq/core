import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyStore } from "../src/policy-store.js";
import {
  DEFAULT_POLICY,
  type Policy,
  policyLockPath,
  policyPath,
  readPolicy,
  withPolicyLock,
  writePolicy,
} from "../src/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-policy-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const withDomains = (allowedDomains: string[]): Policy => ({ ...DEFAULT_POLICY, allowedDomains });

describe("PolicyStore", () => {
  it("starts from the file, or the defaults without one", () => {
    expect(new PolicyStore(dir).current()).toEqual(DEFAULT_POLICY);
    writePolicy(dir, withDomains(["a.com"]));
    expect(new PolicyStore(dir).current().allowedDomains).toEqual(["a.com"]);
  });

  it("re-reads policy.json when it changes, without a restart", () => {
    writePolicy(dir, withDomains(["a.com"]));
    const store = new PolicyStore(dir);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    writePolicy(dir, withDomains(["b.com"]));
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("an in-place edit with the same size is seen through its mtime", () => {
    writeFileSync(policyPath(dir), JSON.stringify(withDomains(["a.com"])));
    const store = new PolicyStore(dir);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    writeFileSync(policyPath(dir), JSON.stringify(withDomains(["b.com"])));
    const later = new Date(statSync(policyPath(dir)).mtimeMs + 5_000);
    utimesSync(policyPath(dir), later, later);
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("an invalid file keeps the last good policy and reports once per change", () => {
    writePolicy(dir, withDomains(["a.com"]));
    const errors: string[] = [];
    const store = new PolicyStore(dir, { err: (l) => errors.push(l) });
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    writeFileSync(policyPath(dir), "{nope");
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/policy\.json is not valid JSON.*keeping the last valid policy/);
    // Another bad version is reported again; a good one is applied.
    writeFileSync(policyPath(dir), JSON.stringify({ cpu: "lots" }));
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    expect(errors).toHaveLength(2);
    writePolicy(dir, withDomains(["c.com"]));
    expect(store.current().allowedDomains).toEqual(["c.com"]);
  });

  it("an invalid network or remoteGrants keeps the last good policy, never a looser one", () => {
    writePolicy(dir, { ...withDomains(["a.com"]), remoteGrants: "off" });
    const errors: string[] = [];
    const store = new PolicyStore(dir, { err: (l) => errors.push(l) });
    expect(store.current().remoteGrants).toBe("off");
    writeFileSync(policyPath(dir), JSON.stringify({ remoteGrants: "yes", network: "open" }));
    expect(store.current()).toMatchObject({ network: "allowlist", remoteGrants: "off" });
    expect(errors[0]).toMatch(/remoteGrants must be "owner" or "off"/);
    writeFileSync(policyPath(dir), JSON.stringify({ network: "everything" }));
    expect(store.current()).toMatchObject({ network: "allowlist", remoteGrants: "off" });
    expect(errors[1]).toMatch(/network must be "allowlist" or "open"/);
  });

  it("a bad version reported once is reported again when it comes back later", () => {
    writePolicy(dir, withDomains(["a.com"]));
    const errors: string[] = [];
    const store = new PolicyStore(dir, { err: (l) => errors.push(l) });
    writeFileSync(policyPath(dir), "{nope");
    store.current();
    store.current();
    expect(errors).toHaveLength(1);
    // Fixing the file with the version it had before still applies it.
    writePolicy(dir, withDomains(["b.com"]));
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("a deleted file means the defaults", () => {
    writePolicy(dir, withDomains(["a.com"]));
    const store = new PolicyStore(dir);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    rmSync(policyPath(dir));
    expect(store.current()).toEqual(DEFAULT_POLICY);
  });

  it("uses the initial policy until the file changes", () => {
    writePolicy(dir, withDomains(["a.com"]));
    const store = new PolicyStore(dir, { initial: withDomains(["init.com"]) });
    expect(store.current().allowedDomains).toEqual(["init.com"]);
    writePolicy(dir, withDomains(["b.com"]));
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("update reads the file, writes the change, swaps the policy and keeps unknown keys", () => {
    writeFileSync(
      policyPath(dir),
      JSON.stringify({ ...withDomains(["a.com"]), futureKey: { x: 1 } }),
    );
    const store = new PolicyStore(dir);
    const next = store.update((p) => ({ ...p, allowedDomains: [...p.allowedDomains, "b.com"] }));
    expect(next.allowedDomains).toEqual(["a.com", "b.com"]);
    expect(store.current().allowedDomains).toEqual(["a.com", "b.com"]);
    const raw = JSON.parse(readFileSync(policyPath(dir), "utf8"));
    expect(raw).toMatchObject({ allowedDomains: ["a.com", "b.com"], futureKey: { x: 1 } });
    expect(statSync(policyPath(dir)).mode & 0o777).toBe(0o600);
    expect(existsSync(policyLockPath(dir))).toBe(false);
  });

  it("update refuses to overwrite an invalid file", () => {
    writeFileSync(policyPath(dir), "{nope");
    // Without an initial policy, an invalid file fails construction (start then refuses).
    expect(() => new PolicyStore(dir)).toThrow(/policy\.json is not valid JSON/);
    const store = new PolicyStore(dir, { initial: DEFAULT_POLICY });
    expect(() => store.update((p) => p)).toThrow(/policy\.json is not valid JSON/);
    expect(readFileSync(policyPath(dir), "utf8")).toBe("{nope");
  });

  it("update sees a change another process wrote since the last read", () => {
    const store = new PolicyStore(dir);
    expect(store.current()).toEqual(DEFAULT_POLICY);
    writePolicy(dir, withDomains(["other.com"]));
    store.update((p) => ({ ...p, allowedDomains: [...p.allowedDomains, "mine.com"] }));
    expect(readPolicy(dir).allowedDomains).toEqual(["other.com", "mine.com"]);
  });
});

describe("withPolicyLock", () => {
  it("holds policy.json.lock while the function runs and removes it after", () => {
    const seen = withPolicyLock(dir, () => existsSync(policyLockPath(dir)));
    expect(seen).toBe(true);
    expect(existsSync(policyLockPath(dir))).toBe(false);
  });

  it("removes the lock when the function throws", () => {
    expect(() =>
      withPolicyLock(dir, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(policyLockPath(dir))).toBe(false);
  });

  it("waits for a held lock and gives up with an actionable error", () => {
    writeFileSync(policyLockPath(dir), "123");
    let ran = false;
    const t0 = Date.now();
    expect(() =>
      withPolicyLock(
        dir,
        () => {
          ran = true;
        },
        { waitMs: 150 },
      ),
    ).toThrow(/policy\.json\.lock.*another capybara-device/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(ran).toBe(false);
    // The other holder's lock is left alone.
    expect(readFileSync(policyLockPath(dir), "utf8")).toBe("123");
  });

  it("never takes over a lock whose holder is alive, however old", () => {
    writeFileSync(policyLockPath(dir), String(process.pid));
    const lockAt = statSync(policyLockPath(dir)).mtimeMs;
    expect(() => withPolicyLock(dir, () => 0, { waitMs: 0, now: () => lockAt + 60_000 })).toThrow(
      /another capybara-device/,
    );
    expect(existsSync(policyLockPath(dir))).toBe(true);
  });

  it("a holder whose lock was taken over leaves the new holder's lock alone", () => {
    withPolicyLock(dir, () => {
      // Another process judged this lock stale and took it over.
      rmSync(policyLockPath(dir));
      writeFileSync(policyLockPath(dir), "other");
    });
    expect(readFileSync(policyLockPath(dir), "utf8")).toBe("other");
  });

  it("serializes writers in separate processes: no update is lost", async () => {
    const script = join(dir, "writer.ts");
    const store = join(import.meta.dirname, "../src/policy-store.ts");
    writeFileSync(
      script,
      `import { PolicyStore } from ${JSON.stringify(store)};
const [, , d, who] = process.argv;
const s = new PolicyStore(d as string);
for (let i = 0; i < 15; i++) {
  s.update((p) => ({ ...p, allowedDomains: [...p.allowedDomains, \`h\${i}.\${who}.com\`] }));
}
`,
    );
    const tsx = join(import.meta.dirname, "../../../node_modules/.bin/tsx");
    const run = (who: string) =>
      new Promise<number | null>((resolve) => {
        const c = spawn(tsx, [script, dir, who], { stdio: "inherit" });
        c.on("exit", (code) => resolve(code));
      });
    expect(await Promise.all(["a", "b", "c", "d"].map(run))).toEqual([0, 0, 0, 0]);
    const all = readPolicy(dir).allowedDomains;
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
  }, 60_000);

  it("takes over a lock older than 10 s", () => {
    // A pid no process has.
    writeFileSync(policyLockPath(dir), "2147483646");
    const lockAt = statSync(policyLockPath(dir)).mtimeMs;
    expect(() => withPolicyLock(dir, () => 0, { waitMs: 0, now: () => lockAt + 9_000 })).toThrow();
    expect(withPolicyLock(dir, () => "ran", { now: () => lockAt + 10_500 })).toBe("ran");
    expect(existsSync(policyLockPath(dir))).toBe(false);
  });
});
