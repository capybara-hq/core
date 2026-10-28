import { Global, Inject, Injectable, Module } from "@nestjs/common";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER } from "../tokens.js";

/**
 * The kernel's in-process domain events (nest kernel spec §3b): a domain announces what happened,
 * and another domain reacts without the first depending on it. Same-process only, so only for
 * notifications that may be lost and are re-derived elsewhere; anything that must reach every
 * replica goes over the kernel bus (`KERNEL_BUS`).
 */
export interface KernelEventMap {
  /**
   * An organization was soft-deleted (after the commit). Channel connections drop their long
   * connections (the connection reads also filter deleted orgs, so a lost event only delays it).
   */
  "org.deleted": { orgId: string };
  /**
   * An organization disabled an extension (after the commit). Its channel connections in the org
   * drop their long connections at once (the supervisor's periodic re-check is the fallback).
   */
  "extension.org-disabled": { orgId: string; plugin: string };
}

type Handler<K extends keyof KernelEventMap> = (payload: KernelEventMap[K]) => Promise<void> | void;

/** Typed in-process event emitter; handlers run in order, a failing one is logged and skipped. */
@Injectable()
export class KernelEvents {
  private readonly handlers = new Map<keyof KernelEventMap, Handler<never>[]>();

  constructor(@Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">) {}

  /** Subscribes; returns the unsubscribe function. */
  on<K extends keyof KernelEventMap>(event: K, handler: Handler<K>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(event, list);
    return () => {
      const at = list.indexOf(handler as Handler<never>);
      if (at >= 0) list.splice(at, 1);
    };
  }

  /** Runs every handler of `event` and waits for them. */
  async emit<K extends keyof KernelEventMap>(event: K, payload: KernelEventMap[K]): Promise<void> {
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      try {
        await (h as Handler<K>)(payload);
      } catch (err) {
        this.log.warn("kernel event handler failed", { event, err });
      }
    }
  }
}

/** Global: the one {@link KernelEvents}. */
@Global()
@Module({ providers: [KernelEvents], exports: [KernelEvents] })
export class KernelEventsModule {}
