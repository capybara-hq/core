import { createHash } from "node:crypto";
import { SandboxOperationOutcomeUnknownError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";

export const OPERATION_CHUNK_BYTES = 65536;
const INLINE_BYTES = 131072;
type Slot = "input" | "result";
export interface PayloadDigest {
  digest: string;
  bytes: number;
  chunks: number;
  inline: string | null;
}
interface PayloadRef {
  version: 1;
  slot: Slot;
  digest: string;
  bytes: number;
  chunks: number;
}
const header = (tag: number, length?: number) => {
  const b = Buffer.alloc(length === undefined ? 1 : 9);
  b[0] = tag;
  if (length !== undefined) b.writeDoubleLE(length, 1);
  return b;
};
/** Binary framing avoids whole-file base64/JSON allocation; UTF-16 preserves every JS code unit. */
function* frames(value: unknown, parents = new Set<object>()): Generator<Uint8Array> {
  if (value === null || value === undefined) {
    yield header(0);
    return;
  }
  if (typeof value === "boolean") {
    yield header(value ? 1 : 2);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite operation payload");
    yield header(3, value);
    return;
  }
  if (typeof value === "string") {
    yield header(4, value.length * 2);
    for (let i = 0; i < value.length; i += 16384)
      yield Buffer.from(value.slice(i, i + 16384), "utf16le");
    return;
  }
  if (value instanceof Uint8Array) {
    yield header(5, value.byteLength);
    for (let i = 0; i < value.length; i += OPERATION_CHUNK_BYTES)
      yield value.subarray(i, i + OPERATION_CHUNK_BYTES);
    return;
  }
  if (typeof value !== "object" || parents.has(value))
    throw new TypeError("Operation payload must be an acyclic native value");
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      yield header(6, value.length);
      for (const v of value) yield* frames(v, parents);
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError("Unsupported operation payload object");
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort();
      yield header(7, keys.length);
      for (const key of keys) {
        yield* frames(key, parents);
        yield* frames(object[key], parents);
      }
    }
  } finally {
    parents.delete(value);
  }
}
export function* operationPayloadChunks(value: unknown): Generator<Buffer> {
  let chunk = Buffer.alloc(OPERATION_CHUNK_BYTES),
    used = 0;
  for (const frame of frames(value))
    for (let offset = 0; offset < frame.byteLength; ) {
      const n = Math.min(chunk.length - used, frame.byteLength - offset);
      chunk.set(frame.subarray(offset, offset + n), used);
      used += n;
      offset += n;
      if (used === chunk.length) {
        yield chunk;
        chunk = Buffer.alloc(OPERATION_CHUNK_BYTES);
        used = 0;
      }
    }
  if (used) yield chunk.subarray(0, used);
}
function inlineValue(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return {
      $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  if (Array.isArray(value)) return value.map(inlineValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineValue(v)]));
  return value;
}
/** JSON text jsonb refuses: an escaped NUL or an escaped (hence lone) surrogate. */
const JSONB_UNSAFE = /\\u(0000|d[89a-f][0-9a-f]{2})/i;
export function describeOperationPayload(value: unknown): PayloadDigest {
  const hash = createHash("sha256");
  let bytes = 0,
    chunks = 0;
  for (const chunk of operationPayloadChunks(value)) {
    hash.update(chunk);
    bytes += chunk.length;
    chunks++;
  }
  // Only a proven-small value enters JSON.stringify; binary data never expands without a bound.
  const json = bytes <= INLINE_BYTES ? (JSON.stringify(inlineValue(value)) ?? "null") : null;
  // jsonb holds no NUL and no lone surrogate (`find -print0` output, say): such a value is kept
  // in chunks, whose framing preserves every UTF-16 code unit
  const inline = json !== null && !JSONB_UNSAFE.test(json) ? json : null;
  return { digest: hash.digest("hex"), bytes, chunks, inline };
}
export function payloadReference(slot: Slot, p: PayloadDigest): string {
  return (
    p.inline ??
    JSON.stringify({
      $operationPayload: {
        version: 1,
        slot,
        digest: p.digest,
        bytes: p.bytes,
        chunks: p.chunks,
      } satisfies PayloadRef,
    })
  );
}
export function isPayloadReference(value: unknown): value is { $operationPayload: PayloadRef } {
  return !!value && typeof value === "object" && "$operationPayload" in value;
}
function invalidPayload(message: string): never {
  throw new SandboxOperationOutcomeUnknownError(message);
}
class PayloadReader {
  private current: Uint8Array = new Uint8Array();
  private offset = 0;
  constructor(
    private readonly chunks: AsyncIterator<Uint8Array>,
    private remaining: number,
  ) {}
  async bytes(n: number): Promise<Buffer> {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining)
      invalidPayload("Invalid retained payload length");
    this.remaining -= n;
    const out = Buffer.alloc(n);
    let used = 0;
    while (used < n) {
      if (this.offset === this.current.length) {
        const next = await this.chunks.next();
        if (next.done) invalidPayload("Retained payload is incomplete");
        this.current = next.value;
        this.offset = 0;
      }
      const size = Math.min(n - used, this.current.length - this.offset);
      out.set(this.current.subarray(this.offset, this.offset + size), used);
      this.offset += size;
      used += size;
    }
    return out;
  }
  async value(): Promise<unknown> {
    const tag = (await this.bytes(1))[0];
    if (tag === 0) return null;
    if (tag === 1) return true;
    if (tag === 2) return false;
    const count = (await this.bytes(8)).readDoubleLE();
    if (tag === 3) return count;
    if (!Number.isSafeInteger(count) || count < 0) invalidPayload("Invalid retained payload size");
    if (tag === 4) return (await this.bytes(count)).toString("utf16le");
    if (tag === 5) {
      const b = await this.bytes(count);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    if (tag === 6) {
      const result: unknown[] = [];
      for (let n = 0; n < count; n++) result.push(await this.value());
      return result;
    }
    if (tag === 7) {
      const result: Record<string, unknown> = {};
      for (let n = 0; n < count; n++) {
        const key = await this.value();
        if (typeof key !== "string") invalidPayload("Invalid retained payload key");
        Object.defineProperty(result, key, {
          value: await this.value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    return invalidPayload("Unknown retained payload encoding");
  }
  async done(): Promise<boolean> {
    return this.offset === this.current.length && (await this.chunks.next()).done === true;
  }
}
/** PG-only storage: bounded bytea rows/batches share the ledger transaction and retention. */
@Injectable()
export class OperationPayloads {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}
  @Transactional({ propagation: "mandatory" })
  async save(
    id: string,
    slot: Slot,
    value: unknown,
    described = describeOperationPayload(value),
  ): Promise<string> {
    await this.db
      .deleteFrom("sandbox_operation_payload_chunks")
      .where("operation_id", "=", id)
      .where("slot", "=", slot)
      .execute();
    if (described.inline !== null) return described.inline;
    const hash = createHash("sha256");
    let bytes = 0,
      sequence = 0,
      batch: { operation_id: string; slot: Slot; sequence: number; data: Buffer }[] = [];
    for (const chunk of operationPayloadChunks(value)) {
      hash.update(chunk);
      bytes += chunk.length;
      batch.push({ operation_id: id, slot, sequence: sequence++, data: chunk });
      if (batch.length === 16) {
        await this.db.insertInto("sandbox_operation_payload_chunks").values(batch).execute();
        batch = [];
      }
    }
    if (batch.length)
      await this.db.insertInto("sandbox_operation_payload_chunks").values(batch).execute();
    if (
      hash.digest("hex") !== described.digest ||
      bytes !== described.bytes ||
      sequence !== described.chunks
    )
      throw new Error("Operation payload changed during persistence");
    return payloadReference(slot, described);
  }
  async load(id: string, slot: Slot, value: unknown): Promise<unknown> {
    if (!isPayloadReference(value)) return value;
    const ref = value.$operationPayload;
    if (
      ref?.version !== 1 ||
      ref.slot !== slot ||
      !/^[a-f0-9]{64}$/.test(ref.digest) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.chunks !== Math.ceil(ref.bytes / OPERATION_CHUNK_BYTES)
    )
      return invalidPayload("Invalid retained payload reference");
    // Validate stored byte counts before decoding lengths can allocate a native result buffer.
    const stored = await this.db
      .selectFrom("sandbox_operation_payload_chunks")
      .select([
        sql<string>`count(*)`.as("chunks"),
        sql<string>`coalesce(sum(octet_length(data)),0)`.as("bytes"),
      ])
      .where("operation_id", "=", id)
      .where("slot", "=", slot)
      .executeTakeFirstOrThrow();
    if (Number(stored.chunks) !== ref.chunks || Number(stored.bytes) !== ref.bytes)
      invalidPayload("Retained payload chunks are incomplete");
    const db = this.db;
    const hash = createHash("sha256");
    let bytes = 0,
      count = 0;
    async function* read() {
      for (let first = 0; first < ref.chunks; first += 16) {
        const rows = await db
          .selectFrom("sandbox_operation_payload_chunks")
          .select(["sequence", "data"])
          .where("operation_id", "=", id)
          .where("slot", "=", slot)
          .where("sequence", ">=", first)
          .where("sequence", "<", Math.min(first + 16, ref.chunks))
          .orderBy("sequence")
          .execute();
        if (rows.length !== Math.min(16, ref.chunks - first))
          invalidPayload("Retained payload chunk is missing");
        for (const row of rows) {
          if (row.sequence !== count || row.data.length > OPERATION_CHUNK_BYTES)
            invalidPayload("Retained payload chunk is missing");
          hash.update(row.data);
          bytes += row.data.length;
          count++;
          yield row.data;
        }
      }
    }
    const reader = new PayloadReader(read(), ref.bytes);
    const result = await reader.value();
    if (
      !(await reader.done()) ||
      bytes !== ref.bytes ||
      count !== ref.chunks ||
      hash.digest("hex") !== ref.digest
    )
      return invalidPayload("Retained payload digest mismatch");
    return result;
  }
  @Transactional({ propagation: "mandatory" })
  async expire(id: string): Promise<void> {
    await this.db
      .deleteFrom("sandbox_operation_payload_chunks")
      .where("operation_id", "=", id)
      .execute();
  }
}
