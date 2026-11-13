import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGitServer, type FakeGitServerOptions, startFakeGitServer } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function server(options?: FakeGitServerOptions): Promise<FakeGitServer> {
  const srv = await startFakeGitServer(options);
  cleanups.push(srv.stop);
  return srv;
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

/** Runs git in an isolated HOME with no helpers, so the host's git config is never touched. */
async function runGit(
  home: string,
  cwd: string,
  args: string[],
  header?: string,
): Promise<{ code: number; out: string }> {
  const cfg = header === undefined ? [] : ["-c", `http.extraHeader=Authorization: ${header}`];
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "credential.helper=", ...cfg, ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-git-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("startFakeGitServer", () => {
  it("clones, pushes and records requests without credential values", async () => {
    const srv = await server({
      repos: ["acme/app"],
      recordAuthorization: false,
      requireBasic: { username: "x", password: "s3cret-token" },
    });
    const auth = basic("x", "s3cret-token");
    const home = await scratch();
    const work = join(await scratch(), "w");
    const clone = await runGit(home, home, ["clone", srv.url("acme/app"), work], auth);
    expect(clone.code, clone.out).toBe(0);
    const seeded = await srv.refOf("acme/app", "refs/heads/main");
    expect(seeded).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(work, "b.txt"), "b\n");
    expect((await runGit(home, work, ["add", "b.txt"])).code).toBe(0);
    expect((await runGit(home, work, ["commit", "-m", "b"])).code).toBe(0);
    const push = await runGit(home, work, ["push", "origin", "HEAD:main"], auth);
    expect(push.code, push.out).toBe(0);
    const head = (await runGit(home, work, ["rev-parse", "HEAD"])).out.trim();
    expect(await srv.refOf("acme/app", "refs/heads/main")).toBe(head);
    expect(head).not.toBe(seeded);
    expect(await srv.refOf("acme/app", "refs/heads/nope")).toBeUndefined();

    const services = new Set(srv.requests.map((r) => r.service));
    expect(services).toContain("git-upload-pack");
    expect(services).toContain("git-receive-pack");
    expect(srv.requests.every((r) => r.authorized)).toBe(true);
    expect(srv.requests.some((r) => r.headerNames.includes("authorization"))).toBe(true);
    const dump = JSON.stringify(srv.requests);
    expect(dump).not.toContain("s3cret-token");
    expect(dump).not.toContain(Buffer.from("x:s3cret-token").toString("base64"));
  });

  it("answers 401 without the matching Basic auth", async () => {
    const srv = await server({
      repos: ["acme/app"],
      requireBasic: { username: "x", password: "p" },
    });
    const url = `${srv.url("acme/app")}/info/refs?service=git-upload-pack`;
    const none = await fetch(url);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Basic realm="fake"');
    expect((await fetch(url, { headers: { authorization: basic("x", "bad") } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: basic("x", "p") } })).status).toBe(200);
    expect(srv.requests.map((r) => r.authorized)).toEqual([false, false, true]);
    const home = await scratch();
    const r = await runGit(home, home, ["clone", srv.url("acme/app"), join(home, "c")]);
    expect(r.code).not.toBe(0);
  });

  it("failNext and redirectNext affect one request only", async () => {
    const srv = await server({ repos: ["r"] });
    const url = `${srv.url("r")}/info/refs?service=git-upload-pack`;
    srv.failNext(403, "denied");
    const failed = await fetch(url);
    expect(failed.status).toBe(403);
    expect(await failed.text()).toBe("denied");
    srv.redirectNext("http://127.0.0.1:9/x");
    const moved = await fetch(url, { redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("http://127.0.0.1:9/x");
    expect((await fetch(url)).status).toBe(200);
  });

  it("leaves repos empty with seed false", async () => {
    const srv = await server({ repos: ["o/empty"], seed: false });
    expect(await srv.refOf("o/empty", "refs/heads/main")).toBeUndefined();
  });

  it("answers 502 once when git http-backend cannot be spawned", async () => {
    const srv = await server();
    await srv.commit("r", { "a.txt": "a" });
    const path = process.env.PATH;
    // the server spawns http-backend with this PATH: no git is found, so the child emits
    // 'error' and then 'close', and only one of them may write the head
    process.env.PATH = "/nonexistent";
    try {
      const res = await fetch(`${srv.url("r")}/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: "0000",
      });
      expect(res.status).toBe(502);
      await res.arrayBuffer();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.env.PATH = path;
    }
  });
});
