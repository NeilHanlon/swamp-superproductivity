// ─────────────────────────────────────────────────────────────────────────────
// sp_wire — the FROZEN file-IPC + HMAC wire core for @kneel/super-productivity.
//
// This is the ONE place that knows the wire format (the plocate-`buildArgv`
// equivalent). It is PURE — no filesystem, no clock, no rate-limit/dedup state —
// so both peers share identical crypto and both can be exercised in isolation.
// The stateful concerns (poll/write I/O, freshness clock, rate-limit counter,
// dedup set) live in the callers: the model's `sendCommand` and the SP plugin's
// verify loop. This module only signs, verifies, and enforces the per-message
// invariants that do NOT need external state.
//
// Contract source of truth: super-productivity-plan.md §3 (envelope + verify
// order) and §4 (hardened protocol items 1–11). Treat §3/§4 as LOCKED.
//
// Implemented via `node:crypto` deliberately: the swamp model runs under Deno and
// the SP plugin runs Node (via PluginAPI.executeNodeScript). Both JS, both the
// same `node:crypto` API → byte-identical HMAC with no canonicalization risk.
//
// KEY PROPERTY (§3, §4 item 6): `payload` is an OPAQUE STRING signed as its exact
// transported bytes. We NEVER re-serialize before verifying — verify the HMAC over
// the bytes we received, THEN JSON.parse. This deletes the sorted-keys dependency
// and its JSON.stringify integer-key-hoisting trap (JWS discipline).
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ── Frozen constants ──────────────────────────────────────────────────────────

/** Protocol version carried in every signed payload (`v`). */
export const PROTOCOL_VERSION = 1 as const;

/** Domain-separation info strings for the per-direction subkeys (§4 item 3). */
export const CMD_INFO = "sp-ipc:command:v1" as const;
export const RSP_INFO = "sp-ipc:response:v1" as const;
// Reserved for a future signed event channel (§4 item 4). NOT used in v1.
export const EVT_INFO = "sp-ipc:event:v1" as const;

/** Freshness window on the signed `ts` (§3 step 4, §4 item 1): |now − ts| ≤ 120s. */
export const FRESHNESS_MS = 120_000;

/** Legal id charset (§3 step 5, §4 FIX-02): reject — never rewrite — on mismatch. */
export const ID_CHARSET = /^[A-Za-z0-9_-]+$/;

/** A provisioned secret record — the 0600 `.auth_token` shape and the vault copy. */
export interface AuthRecord {
  /** Record version. */
  v: number;
  /** 32-byte secret as hex (the HMAC key material for subkey derivation). */
  secret: string;
  /** Random uuid4 bound into every payload as `aud` (§4 item 10). */
  instance: string;
}

/** A signed command payload (pre-serialization). */
export interface CommandPayload {
  v: number;
  id: string;
  ts: number;
  aud: string;
  action: string;
  args: Record<string, unknown>;
}

/** A signed response payload (pre-serialization). */
export interface ResponsePayload {
  v: number;
  id: string;
  ts: number;
  aud: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

/** The on-disk envelope: opaque payload string + hex signature over its bytes. */
export interface Envelope {
  payload: string;
  sig: string;
}

export type Direction = "command" | "response";

/** Structured verify outcome. `count` gates the rate-limiter (§4 item 8): a
 * message that never verified must NOT be counted (unverified flood ⇒ delete,
 * don't count). `del` tells the caller to remove the spoof/garbage file. */
export interface VerifyResult<P> {
  ok: boolean;
  payload?: P;
  /** Stable machine-readable reason on failure (e.g. "bad-signature"). */
  reason?: string;
  /** True only once the HMAC verified — the rate-limiter counts these only. */
  count: boolean;
  /** True when the caller should delete the offending file (spoof/garbage). */
  del: boolean;
}

// ── Subkey derivation (§4 item 3) ─────────────────────────────────────────────

/**
 * Derive the two domain-separated subkeys from the shared secret.
 * `k_cmd = HMAC(secret, "sp-ipc:command:v1")`, `k_rsp = HMAC(secret, "…response…")`.
 *
 * The secret is keyed as its exact UTF-8 string bytes (both peers read the same
 * hex string from the provisioned token / vault), so no hex-decode ambiguity.
 */
export function deriveSubkeys(secret: string): {
  kCmd: Buffer;
  kRsp: Buffer;
  kEvt: Buffer;
} {
  const key = Buffer.from(secret, "utf8");
  return {
    kCmd: createHmac("sha256", key).update(CMD_INFO).digest(),
    kRsp: createHmac("sha256", key).update(RSP_INFO).digest(),
    kEvt: createHmac("sha256", key).update(EVT_INFO).digest(),
  };
}

function subkeyFor(secret: string, dir: Direction): Buffer {
  const { kCmd, kRsp } = deriveSubkeys(secret);
  return dir === "command" ? kCmd : kRsp;
}

/** HMAC-SHA256 over the EXACT payload bytes, hex. (§3, §4 item 6.) */
export function signBytes(subkey: Buffer, payloadStr: string): string {
  return createHmac("sha256", subkey).update(payloadStr, "utf8").digest("hex");
}

/** Timing-safe hex compare. Unequal length ⇒ false (never throws). */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── Building signed envelopes ─────────────────────────────────────────────────

/** Mint a fresh command id (uuid4). Kept here so the model and tests agree. */
export function mintId(): string {
  return randomUUID();
}

/**
 * Build a signed COMMAND envelope. `nowMs` is injected (no ambient clock) so the
 * caller owns freshness and tests are deterministic.
 */
export function buildCommandEnvelope(
  auth: AuthRecord,
  input: {
    id: string;
    ts: number;
    action: string;
    args: Record<string, unknown>;
  },
): Envelope {
  const payloadObj: CommandPayload = {
    v: PROTOCOL_VERSION,
    id: input.id,
    ts: input.ts,
    aud: auth.instance,
    action: input.action,
    args: input.args ?? {},
  };
  const payload = JSON.stringify(payloadObj);
  return {
    payload,
    sig: signBytes(subkeyFor(auth.secret, "command"), payload),
  };
}

/**
 * Build a signed RESPONSE envelope. `id` MUST echo the request id (§4 item 2);
 * the model rejects any response whose signed id ≠ the id it sent.
 */
export function buildResponseEnvelope(
  auth: AuthRecord,
  input:
    | { id: string; ts: number; ok: true; result: unknown }
    | { id: string; ts: number; ok: false; error: unknown },
): Envelope {
  const base = {
    v: PROTOCOL_VERSION,
    id: input.id,
    ts: input.ts,
    aud: auth.instance,
  };
  const payloadObj: ResponsePayload = input.ok
    ? { ...base, ok: true, result: input.result }
    : { ...base, ok: false, error: input.error };
  const payload = JSON.stringify(payloadObj);
  return {
    payload,
    sig: signBytes(subkeyFor(auth.secret, "response"), payload),
  };
}

// ── Verification (§3 verify order; §4 items 1,2,6,10,11) ──────────────────────

function malformed(reason: string): VerifyResult<never> {
  // Not signed / not even shaped like an envelope: garbage, delete, don't count.
  return { ok: false, reason, count: false, del: true };
}

/**
 * Verify an envelope in the FROZEN order (§3):
 *   1. envelope shape ({payload:string, sig:string})
 *   2. timing-safe HMAC over the EXACT payload bytes with the direction's subkey
 *      — on failure: reject + delete, DO NOT count (rate-limit starvation guard)
 *   3. JSON.parse(payload); shape-check; require v===1; require aud === instance
 *   4. freshness: |now − ts| ≤ 120s on the SIGNED ts
 *   5. id charset: reject (never rewrite) if id ∉ [A-Za-z0-9_-]+
 *   (rate-limit step 6 and dedup step 7 are caller state, not here.)
 *
 * `expectId`, when given, binds a response to its request (§4 items 2 & 11): the
 * reader is the sender and asserts payload.id === the id it sent.
 *
 * Everything past step 2 has `count:true` — the HMAC proved provenance, so these
 * are genuine (if stale/misaddressed) messages and the rate-limiter counts them.
 */
export function verifyEnvelope<
  P extends CommandPayload | ResponsePayload = CommandPayload | ResponsePayload,
>(
  auth: AuthRecord,
  envelope: unknown,
  dir: Direction,
  opts: { nowMs: number; expectId?: string },
): VerifyResult<P> {
  // 1. envelope shape
  if (
    typeof envelope !== "object" || envelope === null ||
    typeof (envelope as Envelope).payload !== "string" ||
    typeof (envelope as Envelope).sig !== "string"
  ) {
    return malformed("malformed-envelope");
  }
  const env = envelope as Envelope;

  // 2. HMAC FIRST, over exact bytes. Failure ⇒ delete, DO NOT count.
  const expectedSig = signBytes(subkeyFor(auth.secret, dir), env.payload);
  if (!timingSafeHexEqual(expectedSig, env.sig)) {
    return { ok: false, reason: "bad-signature", count: false, del: true };
  }

  // 3. parse + shape + version + aud
  let payload: P;
  try {
    payload = JSON.parse(env.payload) as P;
  } catch {
    // Verified bytes but non-JSON: provenance held, so count it, but drop it.
    return { ok: false, reason: "unparseable-payload", count: true, del: true };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "bad-shape", count: true, del: true };
  }
  if (payload.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: "bad-version", count: true, del: true };
  }
  if (typeof payload.id !== "string" || typeof payload.ts !== "number") {
    return { ok: false, reason: "bad-shape", count: true, del: true };
  }
  if (payload.aud !== auth.instance) {
    // Cross-install replay (§4 item 10): signed, but not for us.
    return { ok: false, reason: "aud-mismatch", count: true, del: true };
  }

  // 4. freshness on the signed ts (§4 item 1)
  if (Math.abs(opts.nowMs - payload.ts) > FRESHNESS_MS) {
    return { ok: false, reason: "stale", count: true, del: true };
  }

  // 5. id charset — reject, never rewrite (§3 step 5, §4 FIX-02)
  if (!ID_CHARSET.test(payload.id)) {
    return { ok: false, reason: "bad-id-charset", count: true, del: true };
  }

  // response-binds-request (§4 items 2 & 11): filename is untrusted; the
  // authoritative id is payload.id, and it MUST equal the id we sent.
  if (opts.expectId !== undefined && payload.id !== opts.expectId) {
    return { ok: false, reason: "id-mismatch", count: true, del: true };
  }

  return { ok: true, payload, count: true, del: false };
}
