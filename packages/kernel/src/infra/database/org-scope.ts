import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The org scope of the current async context (Postgres RLS spec §5.1,
 * docs/superpowers/specs/2026-11-23-postgres-rls-design.md): the org whose rows the queries of this
 * call chain may see, or the platform scope for deployment-wide work. The scoped pool
 * (`scoped-dialect.ts`) copies it onto every connection a query runs on (`capybara.org_id`,
 * `capybara.scope`), where the row level security policies read it once enforced (`db.rls`).
 *
 * It is set only at entry points, never inside domain services: the org guard of an HTTP request,
 * `runJob` from the job's org, a run's claim, the gateway once a connection or an event resolved
 * its org, the cron ticks, the start sequence and the CLI (platform). A sweep that walks every org
 * and the queries marked `// org-filter: deployment-wide …` run inside {@link asPlatform}.
 */
export type OrgScope =
  | { readonly kind: "org"; readonly orgId: string }
  | { readonly kind: "platform"; readonly reason: string };

/**
 * A slot holding the scope. Scoped runs (`withOrgScope`, `asPlatform`) get a fixed slot; an HTTP
 * request gets an empty one at its start that the guard binds once it knows the org
 * ({@link bindRequestScope}), because a Nest guard cannot wrap the handler in an ALS run.
 */
interface Slot {
  scope: OrgScope | undefined;
  readonly bindable: boolean;
}

const storage = new AsyncLocalStorage<Slot>();

/** The scope of the current async context, or undefined outside any (unscoped). */
export function currentScope(): OrgScope | undefined {
  return storage.getStore()?.scope;
}

/** Runs `fn` scoped to `orgId`: its queries see that org's rows once RLS is enforced. */
export function withOrgScope<T>(orgId: string, fn: () => T): T {
  if (!orgId) throw new Error("withOrgScope needs an org id");
  return storage.run({ scope: { kind: "org", orgId }, bindable: false }, fn);
}

/**
 * Runs `fn` in the platform scope: deployment-wide work (sweeps over every org, relays, super-admin
 * services, lookups made before any org is known). `reason` says why, for review and logs.
 */
export function asPlatform<T>(reason: string, fn: () => T): T {
  if (!reason.trim()) throw new Error("asPlatform needs a reason");
  return storage.run({ scope: { kind: "platform", reason }, bindable: false }, fn);
}

/**
 * Runs `fn` (an HTTP request, from the Fastify `onRequest` hook) with an empty, bindable slot: no
 * scope until a guard binds one with {@link bindRequestScope}.
 */
export function withRequestScopeSlot<T>(fn: () => T): T {
  return storage.run({ scope: undefined, bindable: true }, fn);
}

/**
 * Binds the scope of the current HTTP request (the org guard: the guarded org; the super-admin
 * check: platform; an extension route: its caller's org). Everything the request runs afterwards,
 * the handler included, sees it. Binding the same scope twice is allowed; binding a different one
 * is a programming error (a route both platform and org guarded) and throws. Outside a request
 * slot it does nothing.
 */
export function bindRequestScope(scope: OrgScope): void {
  const slot = storage.getStore();
  // outside a request slot (or inside a fixed scope a caller entered) there is nothing to bind:
  // the context stays as it is, which fails closed once RLS is enforced
  if (!slot?.bindable) return;
  if (slot.scope && scopeKey(slot.scope) !== scopeKey(scope)) {
    throw new Error(
      `The request is already scoped to ${scopeKey(slot.scope)}; refusing ${scopeKey(scope)}`,
    );
  }
  slot.scope = scope;
}

/** A comparable key: `org:<id>`, `platform` or `none`. */
export function scopeKey(scope: OrgScope | undefined): string {
  if (!scope) return "none";
  return scope.kind === "org" ? `org:${scope.orgId}` : "platform";
}

/**
 * Test seam for RLS phase 4 (spec §7): called by the scoped pool for each query that runs with no
 * scope and names an org-scoped table, with that table and the SQL. A test setup installs one that
 * throws to find unscoped paths; undefined (the default) checks nothing. Only the scoped pool
 * (`db.rls` `scoped` or `enforce`) calls it.
 */
export type UnscopedQueryCheck = (table: string, sql: string) => void;
let unscopedCheck: UnscopedQueryCheck | undefined;

export function setUnscopedQueryCheck(check: UnscopedQueryCheck | undefined): void {
  unscopedCheck = check;
}

/** @internal the installed check (read by the scoped pool). */
export function unscopedQueryCheck(): UnscopedQueryCheck | undefined {
  return unscopedCheck;
}
