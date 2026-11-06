import { afterEach, describe, expect, it } from "vitest";
import { type FakeGitServer, startFakeGitServer } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function server(): Promise<FakeGitServer> {
  const srv = await startFakeGitServer();
  cleanups.push(srv.stop);
  return srv;
}

describe("startFakeGitServer", () => {
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
