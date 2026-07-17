# WS3 findings — adversarial live tests + dedup hardening

**Date:** 2026-07-16
**State:** WS3 COMPLETE. All 7 adversarial cases pass against the running SP
plugin. Two dedup-defeating defects found and one fixed; a durable fix
(lockfile) is specced for WS3.5.

Harness: `extensions/models/ws3_adv.ts` (Deno; imports the frozen `sp_wire.ts`).
Observation channels: the plugin's append-only `_debug_scan.log` /
`_debug_tick.log` in the bridge dir (grep by injected filename or command id —
the `_debug_scan.json` snapshot races and is unreliable under load).

---

## Results — all 7 cases pass

| # | Case | Injection | Plugin verdict | Executed? |
|---|------|-----------|----------------|-----------|
| a | Forged signature | valid payload, wrong secret | `bad-signature` (delete, **not counted**) | no |
| b | Replay | valid read, then re-drop same `payload.id` | 1 exec + `deduped` on the copy | once |
| c | Stale timestamp | correctly signed, `ts = now − 300s` | `stale` | no |
| d | Reflection | k_cmd-signed blob into `plugin_responses/` | plugin never reads `responses/`; k_cmd sig ≠ k_rsp sig | no |
| e | aud mismatch | real secret, `aud = wrong-uuid` | `aud-mismatch` | no |
| f | Rate-limit | 35 valid reads in a burst | budget-correct exec + signed `rate_limited` rejects | ~30 |
| g | Cross-key | command payload signed with **k_rsp** | `bad-signature` (domain separation holds) | no |

**Crypto/protocol layer (a, c, d, e, g):** solid on first pass. Timing-safe
HMAC, domain-separated subkeys (k_cmd vs k_rsp), 120s freshness, aud/instance
binding, and count-verified-only all behaved exactly per plan §3/§4. Forged and
cross-key both fail at the HMAC gate and are deleted **without** consuming rate
budget (§4 item 8 starvation guard).

**Rate-limit (f) — verified math, not a naive 30/5:** budget is 30 verified
commands per rolling 60s window. Case b (replay) had just left **2** verified
commands in that window (`_a` executed + `_b` deduped — both HMAC-verified, both
counted). So the burst of 35 split as **28 executed + 7 `rate_limited`** (30 − 2
= 28). All 7 rejects carried properly-signed (k_rsp), correctly-shaped
`{ok:false, error:{code:"rate_limited"}, aud:<ours>}` responses. Reject-not-defer
confirmed: rejects are answered immediately, not queued.

---

## Defect 1 (FIXED) — tick re-entrancy defeats dedup

**Symptom:** a *single* valid command dispatched **twice** (two `dispatch_ok`,
~130ms apart), and a replayed id executed 2× — `deduped` never fired.

**Root cause:** `plugin.js` ran `setInterval(tick, POLL_MS=1000)` where `tick()`
is `async` with **no in-flight guard**. A full tick is ~9 sequential
`executeNodeScript` spawns (scan → dispatch → stage → write + dbgAppends), each
~170ms ≈ 1500ms > 1000ms. So interval N+1 fired while tick N was still running.
The command file isn't deleted until phase 3 (`WRITE_SRC`), and the dedup id
isn't inserted until *after* dispatch (`state.processedIds[c.id] = …`). Two
overlapping ticks therefore both scanned the same undeleted file, both passed the
dedup check (id not yet inserted), and both dispatched. This defeats §4 item 8
("insert on execute ⇒ replay is harmless").

**Fix (plugin.js, v0.1.6):** a `ticking` boolean guard — `if (ticking) return`
at entry, set true, released in a new `finally` (so every early-return path and
error clears it). Serializes ticks within a loop. Confirmed live: single command
→ exactly 1 dispatch.

Also mirrored as a caller-invariant comment block in `sp_plugin_core.ts` (the
codegen source of truth), since that pure module cannot enforce it.

---

## Defect 2 (MITIGATED, durable fix = WS3.5) — loop multiplicity across reloads

**Symptom:** after the re-entrancy fix, a replay still dispatched **5×**. Idle
scan rate was a steady **6 scans/sec**, though `setInterval(tick,1000)` is 1/sec
*per loop* → ~6 concurrent loops. It **grew across the session**: 3/sec at start
→ 6/sec after several plugin reloads.

**Root cause:** SP gives the plugin iframe a fresh JS context on every load
(`index.html` → `<script src="plugin.js">`), and does **not** reliably tear down
the prior iframe. `start()`'s `if (timer) return` only dedups *within one
iframe*. So each reload spawns a new tick loop while stale loops keep polling. N
loops = N separate in-memory `processedIds` dedup sets, all racing on the shared
on-disk bridge dir — the per-loop re-entrancy guard is powerless here.

**Mitigation today:** a **full SP restart** collapses to one loop. Verified: after
restart, idle scan rate dropped to **1/sec** (single loop), and then b and f both
passed cleanly (b: 1 exec + 1 dedup; f: budget-correct).

**Durable fix (TODO WS3.5) — bridge-dir lockfile:**
- On `start()`, before arming `setInterval`, write/read a lock at
  `<dataDir>/.bridge_lock` holding `{pid, startedAt, heartbeatAt}`.
- If a lock exists with a **fresh** heartbeat (e.g. within 2× POLL_MS), the new
  loop **refuses to start its interval** (logs and idles) — only one loop polls.
- The owning loop refreshes `heartbeatAt` each tick; a stale lock (owner died /
  SP crashed) is reclaimable after the heartbeat ages out.
- Single-writer by construction, independent of whether SP tears down old
  iframes. This is the file-IPC analogue of a PID lock; it also protects against
  two *different* SP windows sharing one bridge dir (should never happen given
  the dedicated dir, but cheap insurance).
- Open sub-question: whether to also delete the command file at **scan time**
  (before dispatch) rather than in phase 3, to shrink the race window further.
  With the lockfile the window is closed anyway, so treat this as optional.

---

## Environmental note (not ours)

`ps` showed 5× `super-productivity-mcp` node processes stacking — that's the
*other* MCP integration (b0x42's), separate bridge dir, unrelated to
`@kneel/super-productivity`. Flagged for Neil; may warrant its own cleanup.

---

## Build / deploy reconciliation

The handoff's build step is `zip -r ../sp-swamp-plugin.zip .` → the canonical zip
lives in **`extensions/super-productivity/sp-swamp-plugin.zip`** (parent), NOT in
`plugin/`. A build placed in `plugin/` will not be the one imported. Both
locations are now synced to v0.1.6 (guard present, verified inside the zip).
Version bumped 0.1.5 → 0.1.6 so re-imports are unambiguous.

## Remaining (from the original handoff)

- **Debug-instrumentation cleanup** (still pending): remove `dbgAppend()` + calls
  and the `_debug_*.log` files, rebuild, re-import. Deferred intentionally — the
  debug logs are the observation channel; keep them until WS3.5's lockfile is in
  and re-tested, then strip in one pass.
- **WS4** (breadth): batch ops, counters/time-tracking, trigger_sync, tag/project
  ops — unchanged.
