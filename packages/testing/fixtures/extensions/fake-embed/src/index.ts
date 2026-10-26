import { defineExtension, EMBED_PROTOCOL, type EmbedClaims } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake of an embed extension (`ui.embeds`): the kernel side of embedded apps (token issue and
 * verification, the `/plugin-ui` proxy, `ctx.bus` across replicas) without the official board.
 * - embeds `panel` (org page, `/ui/panel`) and `panel-conv` (conversation tab, `/ui/panel-conv`);
 *   both pages are static HTML loading the static script `/ui/panel.js`; none of them needs a
 *   token. The script speaks the host's message bridge (`capybara-embed/1`): on `init` it fetches
 *   `claims` with the token it was given, shows `<contribution> <orgId>` in `#status` and posts a
 *   `toast` "fake-embed ready" to the host (a failed fetch shows `error <status>`);
 * - every data route checks `Authorization: Bearer <embed token>` with `ctx.ui.verifyEmbedToken`
 *   (401 otherwise); identity comes only from the claims;
 * - `GET /ui/claims` returns the verified claims;
 * - `POST /ui/events` `{ text }` publishes `{ conversationId, text }` on the bus topic
 *   `events.<orgId>` (202);
 * - `GET /ui/events` is an SSE stream: `ready` first, then an `event` for each message in the
 *   token's scope (its conversation, or org-wide messages for a page token); it ends when the
 *   client disconnects or the token expires.
 */

const BEARER_RE = /^Bearer ([A-Za-z0-9._-]{1,4096})$/;
const EventBody = z.object({ text: z.string().min(1).max(200) });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake embed</title><script src="./panel.js"></script></head><body><p>fake-embed</p><p id="status">waiting</p></body></html>`;

const SCRIPT = `(function () {
  var PROTOCOL = "${EMBED_PROTOCOL}";
  var started = false;
  document.addEventListener("DOMContentLoaded", function () { document.body.dataset.ready = "1"; });
  function show(text) { document.getElementById("status").textContent = text; }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.protocol !== PROTOCOL || m.type !== "init") return;
    if (started || typeof m.token !== "string") return;
    started = true;
    fetch("claims", { headers: { authorization: "Bearer " + m.token }, credentials: "omit" })
      .then(function (res) {
        if (!res.ok) throw new Error("error " + res.status);
        return res.json();
      })
      .then(function (c) {
        show(c.contribution + " " + c.orgId);
        window.parent.postMessage({ protocol: PROTOCOL, type: "toast", text: "fake-embed ready" }, "*");
      })
      .catch(function (err) { show(String(err.message)); });
  });
})();
`;

const topic = (orgId: string) => `events.${orgId}`;

const json = (status: number, body: unknown) => Response.json(body, { status });
const unauthorized = () =>
  json(401, { error: { code: "unauthorized", message: "A valid embed token is required" } });

export default defineExtension({
  name: "fake-embed",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  ui: [
    {
      id: "panel",
      title: { zh: "面板", en: "Panel" },
      place: "page",
      kind: "embed",
      path: "/ui/panel",
    },
    {
      id: "panel-conv",
      title: { zh: "面板", en: "Panel" },
      place: "conversation",
      kind: "embed",
      path: "/ui/panel-conv",
    },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ui/panel" },
      { method: "GET", path: "/ui/panel-conv" },
      { method: "GET", path: "/ui/panel.js" },
      { method: "GET", path: "/ui/claims" },
      { method: "POST", path: "/ui/events" },
      { method: "GET", path: "/ui/events" },
    ],
    ui: { embeds: ["panel", "panel-conv"] },
  },
  setup(ctx) {
    const auth = async (req: Request): Promise<EmbedClaims | null> => {
      const m = BEARER_RE.exec(req.headers.get("authorization") ?? "");
      return m?.[1] === undefined ? null : ctx.ui.verifyEmbedToken(m[1]);
    };
    const page = async () =>
      new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    ctx.http.route("GET", "/ui/panel", page);
    ctx.http.route("GET", "/ui/panel-conv", page);
    ctx.http.route(
      "GET",
      "/ui/panel.js",
      async () =>
        new Response(SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
    );

    ctx.http.route("GET", "/ui/claims", async (req) => {
      const claims = await auth(req);
      return claims ? json(200, claims) : unauthorized();
    });

    ctx.http.route("POST", "/ui/events", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      const body = EventBody.safeParse(await req.json().catch(() => undefined));
      if (!body.success) {
        return json(400, { error: { code: "validation_failed", message: "text is required" } });
      }
      await ctx.bus.publish(topic(claims.orgId), {
        conversationId: claims.conversationId ?? null,
        text: body.data.text,
      });
      return json(202, { published: true });
    });

    ctx.http.route("GET", "/ui/events", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      const done = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(Math.max(1, claims.exp * 1000 - Date.now())),
      ]);
      const enc = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => Promise<void>) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (s: string) => {
            if (!closed) controller.enqueue(enc.encode(s));
          };
          const finish = () => {
            if (closed) return;
            closed = true;
            void unsubscribe?.().catch(() => {});
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          };
          unsubscribe = await ctx.bus.subscribe(topic(claims.orgId), (m) => {
            const msg = m as { conversationId?: unknown; text?: unknown } | null;
            if ((msg?.conversationId ?? null) !== (claims.conversationId ?? null)) return;
            send(`event: event\ndata: ${JSON.stringify({ text: String(msg?.text ?? "") })}\n\n`);
          });
          if (done.aborted) {
            finish();
            return;
          }
          done.addEventListener("abort", finish, { once: true });
          send("event: ready\ndata: {}\n\n");
        },
        cancel() {
          closed = true;
          void unsubscribe?.().catch(() => {});
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    });
  },
});
