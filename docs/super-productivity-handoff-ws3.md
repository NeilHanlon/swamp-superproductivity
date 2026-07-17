# Handoff: WS3 adversarial tests + cleanup → WS4 ready

**Date:** 2026-07-16
**State:** G4 (write path) COMPLETE. WS2 proven live. Next: WS3 + cleanup.

---

## Context for next session

Read in order:
1. `~/.claude/projects/-home-neil-dev-swamp/memory/superproductivity-swamp-extension.md`
   — full state, gate decisions, what's built/proven. Updated with G4 completion.
2. `~/dev/swamp/extensions/docs/super-productivity-plan.md` — source of truth,
   §3/§4 LOCKED (do not redesign). WS2 marked COMPLETE, WS3 next.
3. The `swamp` skill.

## Where we are

- **G3 (read path) + G4 (write path) COMPLETE.** Full round-trip working end-to-end.
- 5 unit tests green (sendCommand seam).
- Plugin v0.1.5 installed + enabled in running SP v18.14.0.
- Model `sp` working:
  - `sync` → 366.9KB tasks/projects/tags (3 data handles)
  - `get_tasks` → 499 tasks
  - `notify` → OS notification (524ms)
  - `create_task` → task created (1567ms)
  - `update_task` → title renamed (2078ms)
  - `complete_task` → marked done (1069ms)
- All 4 critical bugs fixed (see memory): `\n` syntax, executeNodeScript return shape, E2BIG, duplicate instance names.
- Test artifact in SP: task `9VI0f0QzkkNSpcd_5U2DC` ("swamp WS2 UPDATED — delete me", done) + WS3 tracking task just created.

## What to do

### 1. WS3: Adversarial live tests against running SP

Test the §4 hardened protocol under attack conditions. The plugin's verifier loop (sp_plugin_core.ts) already implements: timing-safe HMAC, domain-separated subkeys (k_cmd/k_rsp), freshness check (|now - ts| ≤ 120s), dedup on signed payload.id (insert on execute, not receipt), rate-limit (reject-not-defer), action allowlist, instance binding (aud).

**Tests to run** (all should be REJECTED by the plugin):

a. **Forged signature** — sign a command with a wrong secret. Plugin should delete the file, not count it, not respond.

b. **Replayed command ID** — send a valid command, wait for response, then copy the same command file to a new filename with the same payload.id. Plugin should dedup (skip execution), optionally respond with the cached result.

c. **Stale timestamp** — sign a command with ts = now - 300s (beyond 120s window). Plugin should reject as stale.

d. **Reflection attack** — sign a command with k_cmd, write it to plugin_responses/ (pretending to be a response). Model should reject (wrong subkey for direction).

e. **aud mismatch** — sign a command with aud = "wrong-instance-uuid". Plugin should reject.

f. **Rate-limit starvation** — send 35 valid commands in quick succession (rate limit is 30/min). First 30 should execute, remaining 5 should get signed `rate_limited` responses. Model retries with NEW id + fresh ts.

g. **Cross-key attack** — sign a command payload with k_rsp (response subkey) instead of k_cmd. Plugin should reject (wrong direction key).

**How to test:** Write signed command files directly to `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp/plugin_commands/` using Deno scripts that import from `sp_wire.ts` and `super_productivity.ts`. Read the plugin's debug logs (`_debug_scan.log`, `_debug_tick.log`) to confirm rejections. Or watch the bridge dir for response files.

**Gate:** These tests write to the bridge dir, not to SP data (except rate-limit which sends many valid commands). Get explicit OK before running.

### 2. Cleanup: Remove debug instrumentation

Once WS3 passes:

a. Edit `extensions/super-productivity/plugin/plugin.js`:
   - Remove `dbgAppend()` function (lines ~265-274)
   - Remove all `dbgAppend(...)` calls from `tick()` and elsewhere
   - Keep `log()` calls (those go to SP's plugin console, not to disk)

b. Rebuild `sp-swamp-plugin.zip`:
   ```bash
   cd extensions/super-productivity/plugin
   zip -r ../sp-swamp-plugin.zip .
   ```

c. Re-import into SP:
   - Open SP → Settings → Plugins → Remove "kneel-super-productivity-swamp"
   - Import the new `sp-swamp-plugin.zip`
   - Verify plugin loads (check SP console for no errors)

d. Delete the debug log files:
   ```bash
   rm ~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp/_debug_scan.log
   rm ~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp/_debug_tick.log
   ```

e. Update the memory file to note cleanup is done.

### 3. Hand back when ready for WS4

WS4 is breadth: `batchUpdateForProject`, counters/time-tracking (start/stop), `trigger_sync`, tag/project ops. These are already in the `PluginAPI` ceiling but not yet wired into the model. Check the plan §5 for the full list.

---

## Gates (you're the engineer, I check in rather than spin)

- G2 decided: own plugin + own bridge dir. DONE.
- G3 decided: read-only first. DONE.
- G4 decided: writes. DONE.
- G5: no `swamp extension push` until you review.
- **WS3 writes to the bridge dir (not SP data, except rate-limit which sends many valid commands). Get explicit OK before running adversarial tests.**
- **Cleanup removes the plugin from SP and re-imports. Get explicit OK before doing that.**

Anything that pushes to the registry or modifies the live plugin needs your explicit OK. I am not the engineer; you are. Ask me questions if you're unsure rather than letting me spin.

---

## Quick reference

- Bridge dir: `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp`
- Vault: `super-productivity` (local_encryption, keys `secret`+`instance`, instance `c864a2dd-8bc0-4fc6-b21e-e3503e3b2d44`)
- Model instance: `sp` (id `b59dd413-3ef9-474a-9c8f-b20f5d43785b`)
- Plugin manifest id: `kneel-super-productivity-swamp`, v0.1.5
- Unit tests: `~/.swamp/deno/deno test --no-check extensions/models/super_productivity_test.ts --allow-all`
- CLI syntax: `swamp model method run sp <method> --input 'key=value' --json`
