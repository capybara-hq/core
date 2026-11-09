/** Shared helpers for the conversation page tests: events, a fake EventSource, routes. */
import { DEFAULT_LIMITS } from "../../src/lib/attachments";
import type { ConversationEvent } from "../../src/lib/conversations";
import { lastStubRoutes } from "./api";
import { renderRouteWithCache } from "./query";

let seqTime = 0;
export function ev(
  seq: number,
  type: string,
  payload: unknown,
  runId: string | null = "r1",
  conversationId = "c1",
): ConversationEvent {
  seqTime += 1000;
  return {
    conversationId,
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) + seqTime).toISOString(),
  } as ConversationEvent;
}
export const userMsg = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
  ev(
    seq,
    "user_message",
    { content: [{ type: "text", text }], authorAccountId: "a1", ...extra },
    null,
  );
export const runStarted = (seq: number, runId = "r1") =>
  ev(
    seq,
    "run_started",
    { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } },
    runId,
  );

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  /** The browser gave up reconnecting: CLOSED and a plain error event. */
  giveUp() {
    this.readyState = 2;
    this.emit("error");
  }
}

export const CONV = (id = "c1", extra: Record<string, unknown> = {}) => ({
  conversation: {
    id,
    orgId: "o1",
    agentId: "ag1",
    accountId: "a1",
    title: null,
    titleSource: null,
    selection: { model: null, effort: null },
    lastSeq: 0,
    createdAt: "2026-10-26T06:02:00.000Z",
    updatedAt: "2026-10-26T06:02:00.000Z",
    ...extra,
  },
});

const ENV_LIMITS = { cpu: 2, memoryMb: 2048, diskMb: 10240, egress: "allowlist", allowHosts: [] };
export const envView = (id: string, name: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name,
  isDefault: name === null,
  ownerKind: "personal",
  source: "cloud",
  provider: "sandbox-docker",
  available: true,
  online: null,
  machine: null,
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: ENV_LIMITS,
  createdAt: "2026-11-07T08:00:00.000Z",
  ...over,
});

/** The person's devices as `GET /devices` answers them (the composer's picker reads it). */
export const DEVICES = {
  items: [
    envView("e1", null),
    envView("e2", "Build box"),
    envView("e3", "Old box", { available: false }),
  ],
  defaultId: "e1",
  lastUsedId: null,
  cloudAvailable: true,
};

/** An agent's profile as the kernel answers it for an agent created before profiles existed. */
export const PROFILE = {
  avatar: null,
  description: "",
  quickActions: [],
  updatedAt: "2026-10-26T06:00:00.000Z",
};

export const AGENTS = {
  agents: [
    {
      id: "ag1",
      orgId: "o1",
      ownerAccountId: "a1",
      visibility: "org",
      currentVersion: 1,
      definition: {
        name: "Echo agent",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
      },
      profile: PROFILE,
      updatedAt: "2026-10-26T06:00:00.000Z",
    },
    {
      id: "ag2",
      orgId: "o1",
      ownerAccountId: "a1",
      visibility: "org",
      currentVersion: 1,
      definition: {
        name: "Second agent",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
      },
      profile: PROFILE,
      updatedAt: "2026-10-26T06:00:00.000Z",
    },
  ],
};

export const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        {
          id: "fake-1",
          displayName: "Fake 1",
          contextWindow: 1000,
          capabilities: { reasoning: true },
          parameters: [],
        },
        {
          id: "fake-2",
          displayName: "Fake 2",
          capabilities: { reasoning: true },
          parameters: [
            {
              key: "effort",
              standard: "effort",
              schema: { type: "string", enum: ["low", "high"] },
              default: "low",
              label: { zh: "档位", en: "Effort" },
            },
          ],
        },
      ],
    },
  ],
};

/** The kernel's attachment limits (its defaults, as the web app copies them). */
export const LIMITS = { ...DEFAULT_LIMITS };

/**
 * What the conversation page's first load reads besides the conversation and its events,
 * answered empty (an org with nothing else): tests override what they are about.
 */
export function snapshotDefaults(id = "c1"): Parameters<typeof renderRouteWithCache>[1] {
  const ok = (body: unknown) => () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const base = `/api/v1/orgs/o1/conversations/${id}`;
  return {
    "GET /api/v1/orgs/o1/agents": ok(AGENTS),
    "GET /api/v1/orgs/o1/models": ok(MODELS),
    [`GET ${base}/queue`]: ok({ items: [], paused: false }),
    [`GET ${base}/tools`]: ok({ tools: [] }),
    [`GET ${base}/files`]: ok({ files: [], next: null }),
    [`GET ${base}/subagents`]: ok({ subagents: [], next: null }),
    [`GET ${base}/background-tasks`]: ok({ tasks: [] }),
    [`GET ${base}/usage`]: ok({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
    [`GET ${base}/device`]: ok({ device: null }),
    "GET /api/v1/orgs/o1/ui/contributions": ok({ items: [] }),
    "GET /api/v1/orgs/o1/connectors": ok({ connectors: [] }),
    "GET /api/v1/orgs/o1/attachments/limits": ok(LIMITS),
    "GET /api/v1/orgs/o1/agents/ag1/invocable-skills": ok({ skills: [] }),
    "GET /api/v1/orgs/o1/agents/ag2/invocable-skills": ok({ skills: [] }),
  };
}

/**
 * `/chat/<id>` as a document load renders it: the layout prefetches the route's queries on the
 * server from the routes of the latest `stubApi` call (the browser's) over
 * {@link snapshotDefaults}, the cache is hydrated, then the view mounts from it. Pass `routes` to
 * serve the server from others. Returns the server calls and the browser's client.
 */
export function renderChatRoute(
  opts: Parameters<typeof renderRouteWithCache>[2] & {
    id?: string;
    routes?: Parameters<typeof renderRouteWithCache>[1];
  } = {},
) {
  const { id = "c1", routes = lastStubRoutes(), ...rest } = opts;
  return renderRouteWithCache(
    `/chat/${encodeURIComponent(id)}`,
    { ...snapshotDefaults(id), ...routes },
    { locale: "en", ...rest },
  );
}
