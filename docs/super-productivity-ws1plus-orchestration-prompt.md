# Agent handoff — build `@kneel/super-productivity` (WS0b → WS4), Neil in the loop

You are picking up the `@kneel/super-productivity` swamp extension. **WS0 (transport)
is DONE and the `sendCommand` wire contract is FROZEN.** Your job is to orchestrate
the *build* phases against that frozen contract, pausing at the named GATES for Neil.

## Read first (in order)
1. The `swamp` skill — required for this repo, even in plan mode.
2. **Source of truth:** `~/dev/swamp/extensions/docs/super-productivity-plan.md`.
   The frozen wire contract is **§3** (envelope + verify order) and **§4** (the
   hardened protocol, items 1–11). Treat §3/§4 as LOCKED — implement to them
   exactly; do **not** redesign the wire. If you think something in §3/§4 is wrong,
   that's a GATE (stop and raise it with Neil), not a silent change.
3. Memory: `~/.claude/projects/-home-neil-dev-swamp/memory/superproductivity-swamp-extension.md`
   (and `[[no-push-extensions-without-review]]`).
4. Threat model + SP PluginAPI notes: `~/dev/shrug.pw/scratch/SP-MCP/SECURITY_REVIEW.md`.
   The NeilHanlon fork there (`plugin.js`, `mcp_server.py`) is the **proven HMAC
   reference implementation** — mine it for logic, but our envelope is the §3
   opaque-payload form (NOT the fork's `canon(payload)` form; that regression is
   fixed in §4 item 6).
5. Capability ceiling: `~/dev/thirdparty/github.com/johannesjo/super-productivity/src/app/plugins/plugin-api.ts`
   (+ `plugin-api.model.ts`), SP v18.14.0.
6. Reference extension pattern: `~/dev/swamp/extensions/models/plocate.ts` (esp. the
   `buildArgv` seam pattern — `sendCommand` is our equivalent).

## Ground truth you can rely on (from WS0)
- SP here is a **native `/opt/Super Productivity/superproductivity-bin` Electron
  install, NOT Flatpak.** No sandbox. `--user-data-dir=~/.config/superProductivity`.
- Bridge/rendezvous dir (agreed host path, plain `drwx------ neil neil`):
  `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-mcp`
  with `plugin_commands/` + `plugin_responses/`.
- **b0x42 v1.3.x file-IPC is currently installed and LIVE** (its MCP server processes
  are running; `check_connection` → pong). We are shipping our **OWN** plugin — how
  it coexists with / replaces b0x42's live plugin is **GATE G2**.
- Both ends are JavaScript (Deno model + our plugin) — canonical-JSON mismatch is a
  non-issue because we sign opaque bytes, not re-serialized objects.

## GATES — stop and check with Neil (he is the engineer; propose, don't spin)
- **G1 — codegen decision (WS0b):** hand-write the core method/arg Zod schemas now vs
  generate all ~50 from `plugin-api.ts` types. Present a recommendation + the tradeoff;
  let Neil pick. (SP task `fLdbtWcNH3UELGQw0-BQ8`.)
- **G2 — plugin strategy:** our own plugin alongside vs replacing b0x42's live plugin.
  Anything that installs/enables/disables a plugin in his **running** SP needs his
  explicit OK (and may raise the one-time `nodeExecution` consent dialog).
- **G3 — live-SP test consent:** before ANY handshake test that writes to real SP
  data. Agree on a disposable test project/tag or throwaway task; never mutate real
  tasks without an OK. (b0x42 stays the baseline to compare against.)
- **G4 — vault + provisioning:** confirm the swamp vault backend/name for the HMAC
  secret, and provisioning of the `{v,secret,instance}` 0600 file (§3/§4 item 10).
- **G5 — no push:** never `swamp extension push` until Neil reviews (memory rule).

## Phases (orchestrate in order; WS0b can run alongside Phase A)

**Phase A — scaffold + the frozen seam (WS1 core, ship the handshake).**
- Scaffold the `@kneel/super-productivity` extension model (`swamp extension` +
  `extensions/models/`). Honor repo CLAUDE.md: search types first, CEL everywhere,
  Rule 6 fan-out (`sync`/`batch`), pin `npm:` versions, `import { z } from "npm:zod@4"`.
- Implement `sendCommand(action, args)` as the ONE isolated, unit-tested seam, to
  §3/§4 **exactly**: opaque-payload envelope, `k_cmd`/`k_rsp` subkeys, verify→parse
  order, 120s signed-ts freshness, dedup-on-execute, `response.id==request.id`, `aud`,
  atomic `.tmp`+rename writes, reject-not-defer, timing-safe compare. **Build the
  hardening in from day one — do NOT defer it to WS3.**
- Build OUR plugin's verifier half to the same contract (both JS → shared canon-free
  logic). Provision secret from vault → `{v,secret,instance}` 0600 file (G4).
- **Deliverable:** authenticated end-to-end handshake proven (a signed command round-
  trips; a forged/stale/replayed/cross-key command is rejected). Unit tests on the
  seam in isolation.

**Phase B — WS1 `sync` (read-only).** `sync` (Rule-6 fan-out: one execution →
tasks+projects+tags → versioned CEL-referenceable resources) + `get_tasks`,
`get_current_task`, `get_worklog`. Lowest risk, ship first.

**Phase C — WS2 core writes.** `create_task`, `update_task`, `complete_task`, and
`notify` (native OS notification — a genuinely useful workflow primitive).

**Phase D — WS3 adversarial security pass.** The §4 properties are already built in
Phase A; WS3 is the *verification*: adversarial tests (forged sig, replayed id, stale
ts, cross-direction reflection, unverified-flood rate-limit starvation, mid-rotation
restart fail-closed, `aud` mismatch). Confirm each §4 item holds.

**Phase E — WS4 breadth.** `batchUpdateForProject`, counters/time-tracking
(start/stop), `trigger_sync`, tag/project ops.

**Later / not now:** WS5 headless decrypt-read (app-closed bulk snapshots); WS6
(TABLED) SP→swamp events via `serve --webhook`.

## Constraints
- Neil is the engineer; check in at the GATES, ask rather than spin.
- Repo CLAUDE.md swamp rules: search before build, extend-don't-be-clever, CEL/
  `data.latest(...)`, Rule 6 fan-out, pin npm versions, `import { z } from "npm:zod@4"`,
  work through swamp (no raw curl/aws when a model wraps it).
- Do NOT `swamp extension push` (G5). Do NOT touch his running SP without consent
  (G2/G3).
- Track progress in SP: subtasks under parent `cI5Gi13f38jGniqyto0iV` in the "Open
  Source" project. Mark each WS done as you land it.
