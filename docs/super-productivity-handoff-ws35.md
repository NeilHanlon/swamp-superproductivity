# Handoff: WS3.5 single-writer lockfile → then debug cleanup → WS4

**Date:** 2026-07-16
**State:** WS3 COMPLETE (all 7 adversarial cases pass, plugin v0.1.6). Two dedup
defects found: #1 tick re-entrancy FIXED (v0.1.6 `ticking` guard); #2 loop
multiplicity across reloads MITIGATED (SP restart) but not durably fixed. WS3.5
is that durable fix.

---

## Read first (in order)

1. `~/.claude/projects/-home-neil-dev-swamp/memory/superproductivity-swamp-extension.md`
   — full state; WS3 section at top is current.
2. `~/dev/swamp/extensions/docs/super-productivity-ws3-findings.md` — the two
   defects, the evidence, and the lockfile design (defect 2 → durable fix).
3. `~/dev/swamp/extensions/docs/super-productivity-plan.md` — §4 addendum item 12
   (single-writer) is the contract to implement to. §3/§4 LOCKED otherwise.
4. The `swamp` skill.

## Where we are

- Plugin **v0.1.6** live in SP, single healthy tick loop (idle scan rate ~1/sec).
- Canonical zip: `extensions/super-productivity/sp-swamp-plugin.zip` (PARENT dir,
  per the handoff `zip -r ../…` step — NOT `plugin/`). A build left in `plugin/`
  won't be the one imported.
- Bridge dir clean (no leftover test files).
- Debug instrumentation (`_debug_scan.log`/`_debug_tick.log`) still ON — it's the
  observation channel; keep it until WS3.5 is verified.
- Test harness `extensions/models/ws3_adv.ts` still on disk (reuse for WS3.5).

## The bug WS3.5 closes

SP gives the plugin a fresh JS context on every (re)load and does NOT reliably
tear down the prior iframe, so plugin reloads ACCUMULATE tick loops (WS3 saw 3→6
concurrent). Each loop has its own in-memory `processedIds` dedup set, and they
race on the shared on-disk bridge dir → a replayed command executes N×. The
per-loop `ticking` guard (v0.1.6) cannot help across separate loops. Today the
only mitigation is a full SP restart (collapses to 1 loop).

## What to do

### 1. WS3.5 — bridge-dir lockfile (single-writer)

Implement in `extensions/super-productivity/plugin/plugin.js`:

- Lock path: `<dataDir>/.bridge_lock`, JSON `{pid, startedAt, heartbeatAt}`.
- In `start()`, BEFORE arming `setInterval`: read the lock. If it exists with a
  FRESH `heartbeatAt` (within ~2× POLL_MS = 2000ms), this loop is a duplicate —
  log it and DO NOT arm the interval (idle iframe). Otherwise (no lock or stale),
  claim it: write our record, then arm.
- The owning loop refreshes `heartbeatAt` every tick (cheap fs write; reuse the
  fs/path/os direct-exec path to avoid E2BIG/spawn overhead — see WS1 notes).
- A stale lock (owner died / SP crashed) is reclaimable once the heartbeat ages
  out. Guard against two loops claiming simultaneously (write-tmp+rename, then
  re-read to confirm we're the winner; loser backs off).
- Keep the v0.1.6 `ticking` guard — it's still correct for in-loop re-entrancy.
- Bump manifest 0.1.6 → **0.1.7**. Rebuild the canonical PARENT zip:
  `cd extensions/super-productivity && zip -j sp-swamp-plugin.zip plugin/manifest.json plugin/plugin.js plugin/index.html`
  (verify version + presence of the lock code INSIDE the zip before handing off).
- Consider mirroring the single-writer note already in `sp_plugin_core.ts` if the
  lock introduces any shared invariant worth codegen-tracking.

**GATE (G5-adjacent):** this modifies the live plugin. Build the zip; Neil
re-imports (Settings → Plugins → remove kneel-super-productivity-swamp → import
new zip). Do NOT `swamp extension push`.

### 2. Verify WS3.5 — the test that matters is "reload WITHOUT restart"

After Neil re-imports v0.1.7:

a. Confirm single loop: idle scan rate ~1/sec
   (`grep '"filesSeen"' _debug_scan.log | tail`).
b. Re-run replay + rate-limit and confirm they still pass (baseline):
   `deno run --allow-all extensions/models/ws3_adv.ts replay`
   `deno run --allow-all extensions/models/ws3_adv.ts ratelimit`
   (replay ⇒ 1 dispatch + 1 dedup; rate-limit ⇒ budget-correct signed
   `rate_limited`. Remember the rate window carries the 2 verified from replay.)
c. **The real test:** have Neil RELOAD the plugin (not restart SP) a couple
   times, then confirm the idle scan rate STAYS ~1/sec (the lock kept new loops
   from arming). Then re-run replay ⇒ must still be 1 exec + 1 dedup. Before
   v0.1.7 this is exactly where dedup broke (loops accumulated).
d. Clean up any test response files from the bridge dir afterward.

Observation: grep `_debug_scan.log`/`_debug_tick.log` by injected filename or id.
The `_debug_scan.json` snapshot RACES under load — don't trust it. Idle scans/sec
= concurrent-loop count.

### 3. Cleanup — remove debug instrumentation (only after WS3.5 verified)

a. In `plugin.js`: remove `dbgAppend()` + all its calls; keep `log()` (SP console
   only). Leave the lock heartbeat write.
b. Rebuild the canonical PARENT zip, bump to 0.1.8, Neil re-imports.
c. Delete `_debug_scan.log`, `_debug_tick.log`, `_debug_scan.json`,
   `_debug_write.json`, `_pending_results.json` from the bridge dir.
d. Optionally remove `extensions/models/ws3_adv.ts` (ask Neil — he may want it
   kept for regression).
e. Update memory: WS3.5 + cleanup done.

### 4. Then WS4 (breadth)

`batchUpdateForProject`, counters/time-tracking (start/stop), `trigger_sync`,
tag/project ops — already in the PluginAPI ceiling, not yet wired. See plan §5.
Follow Rule 6 (fan-out over loops) for multi-target ops.

---

## Gates (Neil is the engineer; check in, don't spin)

- Any live-plugin change (WS3.5, cleanup) → build zip, Neil re-imports. No auto
  re-import.
- G5: no `swamp extension push` until Neil reviews.
- Adversarial/load tests write to the bridge dir + send read-only
  `get_current_task`; that's pre-approved. Anything touching SP DATA (create/
  update/complete) needs an explicit OK.

## Quick reference

- Bridge dir: `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp`
- Vault: `super-productivity` (keys `secret`+`instance`, instance `c864a2dd-8bc0-4fc6-b21e-e3503e3b2d44`)
- Model instance: `sp` (id `b59dd413-3ef9-474a-9c8f-b20f5d43785b`)
- Plugin id: `kneel-super-productivity-swamp`, current v0.1.6 → building v0.1.7
- Deno: `~/.swamp/deno/deno`
- Unit tests: `~/.swamp/deno/deno test --no-check extensions/models/*_test.ts --allow-all`
- Harness: `~/.swamp/deno/deno run --allow-all extensions/models/ws3_adv.ts <case>`
  (cases: forged|stale|aud|crosskey|reflect|replay|ratelimit)
- Single-command probe: `scratchpad/one.ts` (one signed get_current_task)
- Env note (not ours): 5× `super-productivity-mcp` procs = b0x42's MCP, separate
  bridge dir — leave alone.
