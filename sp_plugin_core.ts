// ─────────────────────────────────────────────────────────────────────────────
// sp_plugin_core — the plugin's STATEFUL verify/execute loop (the §4 hardening
// that the pure wire (sp_wire.ts) deferred to "the plugin loop").
//
// This owns the state the wire core intentionally does not: the rate-limit window
// and the dedup set, plus the §4 ordering around them:
//   • count the rate window on VERIFIED commands only (HMAC passed) — an
//     unverified flood must NOT consume budget, or a token-less same-uid writer
//     starves legit traffic (§4 item 8).
//   • reject-not-defer: over budget ⇒ emit a SIGNED rate_limited response NOW
//     (only ever to a verified command), never queue it into the 120s window.
//   • dedup INSERT on EXECUTE, not on receipt — a rejected/rate-limited command
//     never ran, so replaying it is harmless (§4 item 8).
//   • action allowlist (§4 FIX-10); filename is untrusted — key off payload.id.
//
// It is I/O-injected (now/dispatch/writeResponse/deleteFile) so it runs under the
// bundled Deno for tests. The real SP plugin (plugin.js) embeds this same
// algorithm inside `PluginAPI.executeNodeScript`; keep the two in lockstep (this
// file is the codegen source of truth).
//
// ── CALLER INVARIANT: SINGLE-WRITER / SERIALIZED PROCESSING (proven in WS3) ──
// The dedup guarantee below (INSERT on execute ⇒ replay is harmless) holds ONLY
// if `processCommands` runs against a given bridge dir with no concurrent peer.
// This module cannot enforce that — `processedIds`/`recentVerified` are in-memory
// per caller. WS3 live-tested two ways it breaks in plugin.js and both defeated
// dedup (a replayed id executed 2–5×):
//   1. Tick RE-ENTRANCY — an async tick loop with no in-flight guard: setInterval
//      fires tick N+1 while tick N is mid-flight (a full tick is ~9 sequential
//      executeNodeScript spawns and can exceed the poll interval). Both scan the
//      same not-yet-deleted file, both pass the dedup check before either inserts.
//      Fix in plugin.js: a `ticking` boolean guard, released in `finally`.
//   2. Loop MULTIPLICITY — SP gives the plugin a fresh JS context per (re)load and
//      does not reliably tear down the prior iframe, so reloads ACCUMULATE tick
//      loops (WS3 saw 3→6 concurrent loops over a session). N loops = N separate
//      in-memory dedup sets racing on the shared on-disk bridge dir; the per-loop
//      re-entrancy guard cannot help. Mitigation today: full SP restart collapses
//      to one loop. Durable fix (DONE, WS3.5, plugin v0.1.7): a bridge-dir LOCKFILE
//      `<dataDir>/.bridge_lock` = {owner,pid,startedAt,heartbeatAt}. In start(),
//      BEFORE arming setInterval, a loop claims the lock via atomic fs primitives
//      (O_EXCL create + rename-aside for stale reclaim, never read-then-write). A
//      loop that sees a FRESH lock owned by a peer refuses to arm and idles as a
//      watcher (re-checks every RECLAIM_MS so it promotes itself if the owner dies).
//      The owner refreshes heartbeatAt each tick (folded into the scan's fs pass —
//      no extra spawn) and STANDS DOWN the instant a scan finds the lock is no
//      longer its own. So exactly one loop polls regardless of reloads. This pure
//      module cannot enforce it (in-memory, one caller per instance); the lock lives
//      in plugin.js. See super-productivity-plan.md §4 addendum item 12.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type AuthRecord,
  buildResponseEnvelope,
  type CommandPayload,
  type Envelope,
  verifyEnvelope,
} from "./sp_wire.ts";

export interface PluginConfig {
  /** Verified commands allowed per rolling 60s window (§4 item 8). */
  maxCommandsPerMinute: number;
  /** Dedup retention = window + skew (~window, same host). */
  dedupRetentionMs: number;
  /** Hard cap on the dedup set; MUST stay > rate_limit × window (§4 item 8). */
  dedupCap: number;
  /** Allowed DATA action names — routed to io.dispatch (SP PluginAPI) (§4 FIX-10). */
  allowed: Set<string>;
  /**
   * Allowed META (control-plane) action names — routed to io.dispatchMeta, which
   * acts on LOOP STATE, never PluginAPI (WS7a). MUST be disjoint from `allowed`
   * (a verb's class is decided by which set it is in; overlap ⇒ ambiguous routing).
   * Meta commands ride the IDENTICAL verify pipeline as data and share the same
   * rate/dedup budget — the split is only in the allowlist check + dispatch target.
   */
  metaAllowed: Set<string>;
}

// The DATA (PluginAPI) allowlist — the SINGLE SOURCE OF TRUTH the plugin.js
// `ALLOWED` literal is locked to by the source-parity test (SWAMP-11). Every verb
// the plugin's `dispatch()` switch handles MUST appear here (and vice-versa); the
// parity test fails the build on any drift. Was historically stale at the original
// eight WS1/WS2 reads/writes while plugin.js grew the WS4 breadth verbs — WS7a
// reconciled the two so the parity lock is meaningful.
export const DEFAULT_ALLOWED = new Set([
  "get_snapshot",
  "get_tasks",
  "get_current_task",
  "get_worklog",
  "create_task",
  "update_task",
  "complete_task",
  "notify",
  // WS3 Today mechanism
  "plan_for_today",
  "remove_from_today",
  // WS4 breadth
  "batch",
  "delete_task",
  "log_time",
  "create_tag",
  "update_tag",
  "create_project",
  "update_project",
]);

/** Control-plane verbs (WS7a). Read-only today; WS7b/WS7c add mutating ones. */
export const DEFAULT_META_ALLOWED = new Set([
  "plugin_status",
]);

/**
 * A data verb and a meta verb must never share a name — routing keys off set
 * membership, so an overlap would make a signed command's dispatch target
 * ambiguous (SEC-1). Assert on any (allowed, metaAllowed) pair; called at module
 * load for the shipped defaults and reusable by callers with custom configs.
 */
export function assertDisjointAllowlists(
  allowed: Set<string>,
  metaAllowed: Set<string>,
): void {
  for (const a of metaAllowed) {
    if (allowed.has(a)) {
      throw new Error(
        `sp_plugin_core: action '${a}' is in BOTH the data and meta allowlists`,
      );
    }
  }
}

assertDisjointAllowlists(DEFAULT_ALLOWED, DEFAULT_META_ALLOWED);

export function defaultConfig(): PluginConfig {
  return {
    maxCommandsPerMinute: 30,
    dedupRetentionMs: 120_000, // 2 min = window + skew
    dedupCap: 500, // > 30/min × 2min = 60
    allowed: DEFAULT_ALLOWED,
    metaAllowed: DEFAULT_META_ALLOWED,
  };
}

export interface PluginState {
  /** ms timestamps of VERIFIED commands, for the rolling rate window. */
  recentVerified: number[];
  /** signed id → executedAt ms (dedup, inserted on execute). */
  processedIds: Map<string, number>;
}

export function newState(): PluginState {
  return { recentVerified: [], processedIds: new Map() };
}

/** A command file as seen on disk: its name and raw text content. */
export interface RawFile {
  name: string;
  content: string;
}

export interface PluginIO {
  now: () => number;
  /** Run one allowed DATA action against the SP PluginAPI, returning its result. */
  dispatch: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Run one allowed META action against LOOP STATE (never PluginAPI) (WS7a).
   * Same signature as `dispatch`; the plugin.js impl closes over loop state and
   * the per-tick lock snapshot. Optional so existing callers/tests that never
   * exercise meta verbs need not supply it (a meta verb with no handler throws).
   */
  dispatchMeta?: (
    action: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Persist a signed response envelope for the given id (atomic on the real side). */
  writeResponse: (id: string, env: Envelope) => Promise<void>;
  /** Remove a consumed/rejected command file by name. */
  deleteFile: (name: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ProcessSummary {
  executed: string[];
  rejected: Array<{ name: string; reason: string }>;
  rateLimited: string[];
  deduped: string[];
}

function pruneWindow(times: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return times.filter((t) => t >= cutoff);
}

function pruneDedup(state: PluginState, now: number, cfg: PluginConfig): void {
  // Drop entries past retention, then enforce the hard cap (oldest-first).
  const cutoff = now - cfg.dedupRetentionMs;
  for (const [id, at] of state.processedIds) {
    if (at < cutoff) state.processedIds.delete(id);
  }
  if (state.processedIds.size > cfg.dedupCap) {
    const sorted = [...state.processedIds.entries()].sort((a, b) =>
      a[1] - b[1]
    );
    const drop = state.processedIds.size - cfg.dedupCap;
    for (let i = 0; i < drop; i++) state.processedIds.delete(sorted[i][0]);
  }
}

/**
 * Process a batch of raw command files against the frozen contract. Mutates
 * `state` (rate window + dedup set). Returns a summary for logging/tests.
 *
 * Per-file order: envelope-parse → verifyEnvelope (HMAC→parse→shape/aud→
 * freshness→id-charset) → [count if verified] → rate-limit → dedup → allowlist →
 * execute → sign+write response → insert dedup id → delete file.
 */
export async function processCommands(
  auth: AuthRecord,
  cfg: PluginConfig,
  state: PluginState,
  files: RawFile[],
  io: PluginIO,
): Promise<ProcessSummary> {
  const summary: ProcessSummary = {
    executed: [],
    rejected: [],
    rateLimited: [],
    deduped: [],
  };
  pruneDedup(state, io.now(), cfg);

  for (const f of files) {
    if (f.name.endsWith(".tmp")) continue; // half-written (pre-rename); skip this tick

    // Envelope parse (step 1). Non-JSON garbage: delete, don't count.
    let envObj: unknown;
    try {
      envObj = JSON.parse(f.content);
    } catch {
      summary.rejected.push({ name: f.name, reason: "non-json" });
      await io.deleteFile(f.name);
      continue;
    }

    const now = io.now();
    const r = verifyEnvelope<CommandPayload>(auth, envObj, "command", {
      nowMs: now,
    });

    // §4 item 8: count VERIFIED (HMAC-passed) commands only. `r.count` is true
    // iff the HMAC verified — so an unverified flood cannot consume rate budget.
    if (!r.count) {
      summary.rejected.push({ name: f.name, reason: r.reason ?? "unverified" });
      if (r.del) await io.deleteFile(f.name);
      continue;
    }
    state.recentVerified.push(now);

    // Post-HMAC but failed (stale / aud / id-charset / version): counted, dropped,
    // never signed a rate_limited (it isn't a clean command).
    if (!r.ok || !r.payload) {
      summary.rejected.push({
        name: f.name,
        reason: r.reason ?? "post-hmac-reject",
      });
      if (r.del) await io.deleteFile(f.name);
      continue;
    }
    const p = r.payload;

    // Rate limit (reject-not-defer). Emit a SIGNED rate_limited to this VERIFIED
    // command; the model retries with a new id + fresh ts. Do NOT insert a dedup
    // id (it never executed).
    state.recentVerified = pruneWindow(state.recentVerified, now, 60_000);
    if (state.recentVerified.length > cfg.maxCommandsPerMinute) {
      const env = buildResponseEnvelope(auth, {
        id: p.id,
        ts: now,
        ok: false,
        error: { code: "rate_limited" },
      });
      await io.writeResponse(p.id, env);
      await io.deleteFile(f.name);
      summary.rateLimited.push(p.id);
      continue;
    }

    // Dedup CHECK on the signed id (idempotent). Already executed ⇒ skip silently
    // (the original response already went out); delete the replay.
    if (state.processedIds.has(p.id)) {
      summary.deduped.push(p.id);
      await io.deleteFile(f.name);
      continue;
    }

    // Allowlist + class decision (§4 FIX-10, WS7a SEC-1). Decide the command's
    // class ONCE here, where the verified action is available: data verbs route to
    // io.dispatch (SP PluginAPI), meta verbs to io.dispatchMeta (loop state). A verb
    // in NEITHER list is forbidden. Data is checked first, so even a (load-asserted-
    // impossible) overlap routes deterministically to data rather than meta.
    const isData = cfg.allowed.has(p.action);
    const isMeta = !isData && cfg.metaAllowed.has(p.action);
    if (!isData && !isMeta) {
      const env = buildResponseEnvelope(auth, {
        id: p.id,
        ts: now,
        ok: false,
        error: { code: "forbidden_action", action: p.action },
      });
      await io.writeResponse(p.id, env);
      await io.deleteFile(f.name);
      summary.rejected.push({ name: f.name, reason: "forbidden_action" });
      continue;
    }

    // Execute, then respond, then INSERT the dedup id (on execute, not receipt).
    let env: Envelope;
    try {
      let result: unknown;
      if (isMeta) {
        if (!io.dispatchMeta) {
          throw new Error(`no meta dispatcher for action '${p.action}'`);
        }
        result = await io.dispatchMeta(p.action, p.args);
      } else {
        result = await io.dispatch(p.action, p.args);
      }
      env = buildResponseEnvelope(auth, {
        id: p.id,
        ts: io.now(),
        ok: true,
        result,
      });
      summary.executed.push(p.id);
    } catch (e) {
      env = buildResponseEnvelope(auth, {
        id: p.id,
        ts: io.now(),
        ok: false,
        error: {
          code: "exec_failed",
          message: e instanceof Error ? e.message : String(e),
        },
      });
      summary.rejected.push({ name: f.name, reason: "exec_failed" });
    }
    await io.writeResponse(p.id, env);
    state.processedIds.set(p.id, io.now()); // dedup insert ON EXECUTE
    await io.deleteFile(f.name);
  }

  return summary;
}
