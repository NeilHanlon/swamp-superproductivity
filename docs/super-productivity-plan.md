# Plan: `@kneel/super-productivity` swamp extension

**Status:** **G4 COMPLETE (2026-07-16).** All 4 core write methods proven live against SP v18.14.0. Plugin v0.1.5 stable, model `sp` working. WS3 (adversarial live tests) next, then cleanup debug instrumentation.

**Owner collective:** `@kneel` (confirmed).
**Fit rating for swamp:** 7/10 — a legitimate, useful *integration/automation*
model (same class as the installed `@bixu/github/actions`), with strong
workflow/CEL upside for Neil's existing automation graph. Docked for: (a) SP must
be running for the write path, (b) IPC-not-API transport (~1s poll / 30s timeout,
timing-sensitive), (c) event/record vs. declarative-resource semantic mismatch.

---

## 1. Decision (first-principles)

We are **not** mirroring the MCP servers' tool surface. The MCP verb set
(~26 tools) is optimized for a conversational LLM and uses only ~1/3 of what SP
can actually do. Swamp's consumers are workflows/CEL/reports, so we design
against **SP's `PluginAPI` capability ceiling**, not the MCP surface.

**Chosen architecture — Option 2: own an SP plugin; the swamp model talks to it
directly, with an auth layer neither upstream bridge has.** The swamp model *is*
the "server" half — no third-party Node/Python MCP server in the loop. Rationale
(Neil's words): the MCPs "add a layer we don't need and present swiss cheese."

**Transport — file-IPC + HMAC (DECIDED, WS0 2026-07-15).** The swamp consumer is
**ephemeral** — a fresh short-lived Deno process per `swamp model method run` — so
the swamp→SP command path is **request/response** (reads must return a body). The
two candidates were weighed against *that* consumer, not a persistent MCP server:
- **localhost HTTP (ben-elliot's model) requires a persistent daemon** as the
  rendezvous, because a browser iframe can only `fetch` **out**, never listen — the
  iframe polls an always-on endpoint for commands. An ephemeral swamp method cannot
  *be* that endpoint, so HTTP forces a third always-on process — exactly the "extra
  layer we don't need" that killed Option 1. (Neil raised swamp `serve`/`--webhook`
  as the always-on host: it fits the SP→swamp *event* push direction, but **not**
  the command path — webhooks are inbound-to-swamp, fire-and-forget, no response
  body; `serve` is the `wss` protocol API, not a generic command queue. See §5 WS6,
  tabled.)
- **file-IPC — the shared directory IS the rendezvous, no daemon.** The ephemeral
  method writes a signed command file and polls for the signed response file, then
  exits; the long-lived plugin polls the dir on its own cadence. The ephemeral
  nature *inverts* the usual "HTTP > files" heuristic: for a per-run consumer the
  filesystem is the simplest message queue.

**Feasibility (WS0 evidence):** file-IPC is **proven live on this machine** —
`check_connection` → `{status:connected, pong:true}` is a full round-trip through
the bridge dir. **Premise correction:** SP here is **not** Flatpak — it's a native
`/opt/Super Productivity/superproductivity-bin` Electron install (`flatpak list`
shows no SP; user-data-dir `~/.config/superProductivity`). The bridge dir
`~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-mcp` is
just a plain host directory both peers agree on (`drwx------ neil neil`), fully
reachable by any host Deno process — no sandbox mediates it. HTTP was also
CSP-feasible (SP's app CSP is `connect-src *`, `src/index.html:89`, inherited by the
`srcdoc allow-same-origin` plugin iframe, `plugin-index.component.html:73`) —
feasibility was never the deciding factor; the daemon requirement was.

We ship **our own** SP plugin (Option 2) and add the auth both upstreams lack — the
hardened protocol in §4, carrying forward the *rationale* of the NeilHanlon
FIX-01..10 fork (`~/dev/shrug.pw/scratch/SP-MCP`), not b0x42's unhardened build.

**Fast-follow — Option 3: event-driven + issue-provider (TABLED).** SP→swamp events
(hooks) and, later, `registerIssueProvider`. WS0 identified the clean swamp-native
carrier for the event direction — `swamp serve --webhook` (inbound, HMAC-validated,
triggers a workflow; `generic` scheme fits our own signature) with the SP plugin
`fetch`ing out. **Parked, not committed:** with file-IPC maintained for the command
path regardless, a second (event) channel must earn its place — it's an addition,
not a solution. See §5 WS6. Open question on issue-provider scope: §9.

**Rejected — Option 1 (thin client over b0x42 / ben-elliot-nice):** couples us to
a third-party build we don't control, that is behind, and (for b0x42) unhardened.

---

## 2. Ground truth (investigation findings, 2026-07-15)

### The live stack on this machine
- Active MCP server = **`b0x42/Super-Productivity-MCP`**, npm `super-productivity-mcp`,
  **Node/TS**, pinned **v1.3.1**. Configured in `~/.claude.json` as
  `npx -y super-productivity-mcp`. Cached at
  `~/.npm/_npx/6b48eba35c5edac0/node_modules/super-productivity-mcp`.
- The Python `~/.local/share/super-productivity-mcp/mcp_server.py` is a **dormant
  leftover** from earlier hardening work — NOT what runs.
- Live SP-side plugin (bundled in the npm pkg's `dist/plugin.zip`): manifest
  **v1.3.1**, `permissions: [nodeExecution]`, hooks
  `taskUpdate/taskComplete/taskDelete/currentTaskChange`.
- `check_connection` → connected, pluginVersion 1.3.0/1.3.1, protocolVersion 1,
  dataDir `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-mcp`
  (**NB: bridge/rendezvous dir only — SP itself is a native `/opt` Electron install
  here, NOT Flatpak; see §1 WS0 premise correction**).

### Lineage (verified via upstream survey 2026-07-15)
Two lineages, now with **incompatible, both-unauthenticated** transports:
- `ben-elliot-nice/superproductivity-mcp` — **Python, v2.2.1** (commit 2026-06-22),
  PyPI `superproductivity-mcp`. **Moved OFF file-IPC at v2.0.0 → localhost HTTP
  daemon.** `BridgeDaemon` (`ThreadingHTTPServer` on `localhost:27833`, singleton,
  PID file, multi-session UUIDs, 30s heartbeat, 90s TTL). SP side is an **iFrame
  plugin, `permissions: []`** (no nodeExecution) that scans ports from 27833,
  `GET /commands`, executes via `PluginAPI`, `POST /response/{id}`. 16 MCP tools.
  **No auth/HMAC** — `/session/register` accepts any POST, `ACAO: *`; changelog
  "hardening" = reliability (reconnect/TTL), not security.
- `b0x42/Super-Productivity-MCP` — **independent Node/TS build** (`fork:false`,
  no parent — the "small delta" premise was wrong; tool-name similarity to the
  Python line is convergent, not genealogical). **Latest v1.3.4** (2026-07-12;
  the "2.2.1" was ben-elliot's version, conflated). **Still file-IPC +
  nodeExecution**, ~27 tools, **no HMAC/auth**. 1.3.1→1.3.4 = SP-compat patches
  only. This is the build currently installed on Neil's machine.
- `organicmoron/SP-MCP` — original Python, file-IPC.
- `NeilHanlon/SP-MCP` — Neil's hardened Python fork of organicmoron (FIX-01..10,
  the **only** lineage with HMAC signing). `~/dev/shrug.pw/scratch/SP-MCP`; see
  `SECURITY_REVIEW.md` + `HANDOFF.md`. Its FIX-01 auth rationale is what we carry
  forward onto whichever transport we ship.

### Transport landscape
- **No first-party SP MCP/bridge exists** — all community. Two live wire formats:
  b0x42 = **file-IPC** (`plugin_commands/`+`plugin_responses/`, nodeExecution,
  ~2s poll); ben-elliot = **localhost HTTP daemon** (27833). **Neither is
  authenticated.** We adopt ben-elliot's *transport idea* (iFrame + localhost
  fetch, `permissions: []`) but not its code, and add the auth layer both lack.
- The hardened NeilHanlon file-IPC protocol (`{payload, signature}`,
  `HMAC-SHA256(json.dumps(sort_keys=True))`, 0600 `.auth_token`, allowlist, TTL,
  rate-limit, idempotency) is our **fallback transport** and the source of the
  auth pattern.

### Tool-registration question — ANSWERED
The SP plugin does **not** advertise its tools on connect. The ~27 tools are
**hardcoded `registerTool` calls in the MCP server** (26 in b0x42's `dist/index.js`).
The plugin exposes a **fixed ~23-action** handler set, itself a thin veneer over
`PluginAPI`. Tool count is a server presentation choice, decoupled from real
capability. **The true ceiling is `PluginAPI`.**

### SP `PluginAPI` ceiling (authoritative, from checked-out source v18.14.0)
Source: `~/dev/thirdparty/github.com/johannesjo/super-productivity/src/app/plugins/plugin-api.ts`
(+ `plugin-api.model.ts`). ~50 methods. Highlights the bridges DON'T expose:
- **Reads:** getTasks, getArchivedTasks, getCurrentContextTasks, getSelectedTask,
  getFocusedTask, getActiveWorkContext, getAppState, getConfig, getAllProjects,
  getAllTags.
- **Writes:** addTask, updateTask, deleteTask, addProject, updateProject, addTag,
  updateTag, selectTask, **batchUpdateForProject** (first-class batch).
- **Time tracking:** counters + simpleCounters (get/set/increment/decrement/…).
- **UI/notify:** showSnack, **notify** (native OS notification), openDialog,
  downloadFile, showIndexHtmlAsView.
- **State/sync:** persistDataSynced/loadSyncedData (per-plugin 1MB, 1/s slot),
  reInitData, **triggerSync** (force sync to configured remote),
  **dispatchAction** (dispatch any NgRx action — escape hatch).
- **Integration:** **registerHook** (events), registerHeaderButton,
  registerMenuEntry, **registerIssueProvider**, startOAuthFlow/getOAuthToken/
  clearOAuthToken, **setSecret**, translate/getCurrentLanguage.
- **Hooks (events):** taskUpdate, taskComplete, taskDelete, currentTaskChange,
  plus an `ACTION` firehose over every NgRx action.

### Headless read (no app running) — VIABLE, read/export only
- If SP **encryption is OFF**, the synced/uploaded file is **plain JSON** — read
  it directly from the sync target (WebDAV/Nextcloud/LocalFile/Dropbox).
- If **ON**, it is externally decryptable (no official CLI; reimplement):
  framing `SP_ENC_` base64 `[SALT(16)][IV(12)][CT+TAG]`, **AES-256-GCM**, key via
  **Argon2id** (`hash-wasm`, iterations=3, memory=64 MiB, parallelism=1) from the
  **user's password**; compression layer prefixed `SP_CPR_`. Legacy = PBKDF2-SHA256
  iter=1000 (weak), framing `[IV(12)][CT+TAG]`. Source:
  `super-productivity/packages/sync-core/src/encryption/{web-crypto,argon2,legacy}.ts`.
- **This is a bulk read/export path, NOT a write path** — SP owns its op-log;
  writing the file underneath risks sync-conflict/divergence (and the README's
  data-loss warning). Writes go through the plugin (app running). SP has **no**
  first-party REST/websocket/headless-CLI.
- **Design consequence — hybrid:** bulk reads (`sync` snapshots for CEL/reports)
  can come from the decrypted/plain sync file with the **app closed**; mutations
  and live reads use the plugin bridge (app open). This materially softens the
  "app must be running" fit penalty for the read-heavy workflow cases.

---

## 3. The swamp model shape

**Type:** `@kneel/super-productivity`. One model instance = one SP bridge dir.

### Design against the ceiling via codegen (swamp-driven, if feasible)
SP's `PluginAPI` is fully typed. Rather than hand-maintain ~50 methods, **generate**
the swamp model's method list + Zod arg schemas AND the plugin's action handlers
from SP's `plugin-api.ts` / `plugin-api.model.ts` types. This keeps us pinned to
the ceiling and cheap to resync when SP bumps the API. Treat codegen as a
first-class workstream (WS0), even if v1 hand-writes the core subset.

### Global arguments (Zod)
- `dataDir` — the bridge (rendezvous) dir. **Explicit/required arg — do NOT infer
  from SP install type.** WS0 found the rendezvous path is decoupled from SP's
  user-data-dir (here SP is native at `~/.config/superProductivity` yet the bridge
  is `~/.var/app/.../super-productivity-mcp`); it's whatever absolute path both
  peers agree on. Auto-detect may *suggest* a default, but the arg is authoritative.
- `authTokenPath` (default `<dataDir>/.auth_token`), `commandTimeoutS` (30),
  `pollIntervalMs` (500), `excludeTags` (privacy filter, mirrors
  `SP_MCP_EXCLUDE_TAGS`).

### Frozen transport seam — `sendCommand(action, args)` (LOCKED, WS0 2026-07-15)
The plocate-`buildArgv` equivalent; the ONE place that knows the wire format;
unit-tested in isolation. **Transport = file-IPC + HMAC.** Frozen surface = the
opaque-payload envelope, the two domain-separated subkeys, the signed
`{v,id,ts,aud,…}` fields, verify-before-parse, freshness-on-signed-ts,
dedup-on-signed-id, response-binds-request-id, and atomic writes. Implementation
behind the signature stays swappable.

**`payload` is an OPAQUE STRING signed as exact bytes — never re-serialized.** No
canonicalization: verify the HMAC over the transported bytes, *then* parse. This
deletes the sorted-keys dependency and its latent `JSON.stringify`
integer-key-hoisting trap, and keeps the wire correct if a non-JS peer ever appears
(JWS discipline).

```
Provisioned file <dataDir>/.auth_token (0600) = { "v":1, "secret":"<32B hex>", "instance":"<uuid4>" }
  (secret of record in a swamp VAULT; file is the plugin's copy — the plugin can't reach vaults)
k_cmd = HMAC-SHA256(secret,"sp-ipc:command:v1")   k_rsp = HMAC-SHA256(secret,"sp-ipc:response:v1")

command   plugin_commands/<id>.json =
  { "payload": "<json-string>", "sig": "<hex HMAC(k_cmd, payload_bytes)>" }
    payload (pre-serialization) = { v:1, id:<uuid>, ts:<epoch_ms>, aud:<instance>, action:<str>, args:{…} }
response  plugin_responses/<id>_response.json =
  { "payload": "<json-string>", "sig": "<hex HMAC(k_rsp, payload_bytes)>" }
    payload = { v:1, id:<echoes req id>, ts:<epoch_ms>, aud:<instance>, ok:<bool>, result:<…> | error:<…> }

verify (each side), IN ORDER:
  1. read file → JSON.parse the ENVELOPE only (payload stays a string)
  2. timing-safe HMAC over env.payload EXACT BYTES with the DIRECTION's subkey  → else reject+delete, DO NOT count
  3. JSON.parse(env.payload); shape-check; require aud == our instance uuid
  4. freshness: reject if |now − ts| > 120_000ms   (signed ts authoritative; mtime = pre-filter hint only)
  5. id charset: REJECT (never rewrite) if id ∉ [A-Za-z0-9_-]+   (a rewritten id ≠ the signed id)
  6. rate limit: count VERIFIED commands only; over budget ⇒ emit signed `rate_limited` NOW (never defer)
  7. dedup CHECK on signed payload.id → if already executed, skip (idempotent); else execute, then INSERT id
     ON EXECUTE (not on receipt): a rejected/rate-limited cmd never ran, so replaying it is harmless
  a response's id MUST equal the request id.  filename = UNTRUSTED metadata: authoritative id is payload.id

writes are ATOMIC: <id>.json.tmp then rename() (same for .auth_token) — a half-flushed file reads as tampering
  and would be deleted as a spoof, eating legit in-flight traffic
retry: any rejection (incl. rate_limited) ⇒ model mints a NEW id + fresh ts — NEVER reuse the id (same-id retry
  self-collides: new bytes, same id → dedup-replay reject). plugin also: action allowlist
dedup: retention = window + skew (~window, same host); max in-flight = rate_limit × window (30/min×2min = 60);
  cap (500) must stay > that and scale with the rate limit (else eviction-within-window reopens replay)
rotation (provisioning-side flag by MOTIVE): hygiene ⇒ dual-verify (write file FIRST; try k_new then k_old one
  window, drop old); compromise ⇒ HARD CUT (drop old NOW — dual-verify gifts the old secret +120s). Dual-verify
  window is IN PLUGIN MEMORY: restart mid-rotation drops k_old ⇒ in-flight old-key cmds bounce (fail-closed, NOT
  seamless across restart). reload trigger = (size,mtime) or content hash, NOT mtime alone (2 rewrites/tick ⇒ stale)
key sourcing: model reads the vault per ephemeral run (rotation free on the model side)
reader binding: the process that reads a response MUST be the one that sent it (holds the req id) — assert, not assume
  (the rate_limited retry stays within one run, so send→poll→read still holds)
```

- **Read-only shortcut — decrypt sync file.** For `sync`/bulk reads, `sendCommand`
  may bypass the plugin entirely and read the decrypted/plain sync JSON (app can
  be closed). See §2 Headless read.

### Resources (versioned, CEL-referenceable; short lifetime ~5m = "snapshot stale")
`tasks`, `projects`, `tags`, `worklog` (from counters), `currentTask`.

### Methods (v1 = "read + core writes", per Neil)
- `sync` — one execution pulls tasks+projects+tags → writes all resources
  (Rule 6 fan-out; avoids per-model lock contention).
- Reads: `get_tasks`, `get_current_task`, `get_worklog`.
- Writes: `create_task`, `update_task`, `complete_task`.
- `notify` (native notification) — a genuinely useful workflow primitive.
- (Later) `batch_update` (batchUpdateForProject), tracking (start/stop via
  counters), `trigger_sync`, tag ops, project ops.

---

## 4. Security / transport hardening (hardened protocol, WS0 2026-07-15)
Threat model = **same-uid local processes** (SECURITY_REVIEW FINDING-01): anything
that can write `plugin_commands/` executes with plugin authority (plugin runs
unsandboxed in SP's main thread). HMAC + allowlist are non-negotiable. We ship this
on **our own** plugin, not b0x42's unhardened build. This protocol supersedes the
raw FIX-01..10 list; it folds in five corrections flagged in the NeilHanlon fork:

1. **Freshness is a signed field, not `mtime`.** `mtime` is attacker-forgeable
   (`utime()` → free 5-min reset); it's a scheduling hint, not a security control.
   The verifier checks `|now − payload.ts| ≤ 120s` on the **signed** `ts`, after
   HMAC verify. Same host ⇒ shared clock ⇒ a tight window is safe. (corrects FIX-04)
2. **Idempotency key comes from the signed payload, not the filename.** A dedup set
   keyed on a filename-derived id is defeated by copy-to-new-filename (same signed
   bytes, new name, replays). Dedup keys on `payload.id`; the response must echo the
   request id and the model rejects any response whose signed id ≠ the id it sent
   (binds response to command → kills reflection). (corrects FIX-08)
3. **Domain-separated subkeys per direction.** One key both ways in one dir is one
   confusable payload shape away from reflecting a command as a response. `k_cmd =
   HMAC(secret,"sp-ipc:command:v1")`, `k_rsp = HMAC(secret,"sp-ipc:response:v1")`;
   sign each direction with its subkey. Responses are signed too — an unsigned
   response is forged data into the CEL graph, worse than a forged command.
   (corrects FIX-01)
4. **No unsigned channel.** v1 has no event-file channel at all (command path only).
   Any future event channel is signed (`k_evt = HMAC(secret,"sp-ipc:event:v1")`) or
   rides the tabled webhook path (§5 WS6) — never unsigned.
5. **Secret in a swamp vault; rotation without footguns.** Secret of record lives in
   a swamp vault; the model (ephemeral, new process per run) reads it from the vault
   each run ⇒ rotation is free with zero per-cycle logic. The 0600 `.auth_token` is
   only the plugin's provisioned copy (the plugin, inside SP, can't reach vaults);
   the plugin reloads it **on mtime-change only**, never blindly per cycle — blind
   re-read adds nothing against a same-uid attacker who could already forge, but adds
   accidental-break + mid-flight rotation races.

**WS0 adversarial-review hardening (2026-07-15) — locked alongside 1–5:**

6. **Sign exact bytes; verify before parse.** The envelope's `payload` is an opaque
   string; `sig` covers those exact transported bytes. Verify HMAC first, *then*
   `JSON.parse`. No canonicalization — removes the sorted-keys dependency and its
   latent `JSON.stringify` integer-key-hoisting incompatibility with any non-JS
   peer. Verify order is fixed (HMAC → parse → shape/`aud` → freshness → id-charset
   → dedup) and **id-charset rejects, never rewrites** (a rewritten id ≠ the signed
   id you dedup on). *(This reverses the earlier "canon(): both ends are JS" idea —
   opaque-bytes is strictly better and makes the incompatibility question not exist.)*
7. **Atomic writes.** `<id>.json.tmp` → `rename()`; same for `.auth_token`. A reader
   polling on mtime can otherwise catch a half-flushed file, and a truncated payload
   is indistinguishable from tampering → containment (delete + log spoof) would eat
   legitimate in-flight traffic; a partial token read fails every command closed.
8. **Over-rate ⇒ reject now, never defer — and dedup on execute.** Deferring excess
   collides with the 120s window (a queued tail ages out and is rejected *as a
   security failure*). Emit a signed `rate_limited` **after verify**; the model
   retries with a **new id + fresh ts** — never reuse the id (a same-id retry
   self-collides: new bytes, same id → dedup-replay reject). Two rules keep this
   consistent: (a) the dedup id is inserted **on _execute_, not on receipt** — a
   rejected/rate-limited command never ran, so replaying it is harmless and there's
   nothing to protect; (b) the **rate-limit counter increments on _verified_
   commands only** — counting unverified files would let a token-less same-uid
   flooder starve legit traffic (the one denial a writer *without* the secret can
   mount), so unverified ⇒ delete, don't count, and never sign a `rate_limited`
   response to arbitrary input. Counts stay derivable: dedup retention = `window +
   skew` (~window, same host); max in-flight = `rate_limit × window` (30/min × 2min =
   60); the dedup cap (500) must stay above that and **scale with the rate limit**,
   else eviction-within-window reopens replay. (Supersedes FIX-03's defer-to-cycle.)
9. **Rotation — motive-driven, provisioning-side flag.** Write `.auth_token`
   **first**, then by *why* you're rotating: **hygiene/routine ⇒ dual-verify** — try
   `k_new` first, fall back to `k_old` for one freshness window, then drop old
   (steady state = one check; the fallback only fires for genuinely-old traffic; no
   cross-key outage). **Compromise ⇒ hard cut** — drop `k_old` immediately; dual-
   verify would hand an attacker holding the old secret a full extra window of
   validity, exactly what you're rotating to end. The choice is a flag set at
   provisioning, not a 2am judgment call. The dual-verify window lives **in plugin
   memory**: a restart mid-rotation drops `k_old`, so in-flight old-key commands
   bounce — correct **fail-closed**, but not seamless across a restart. Reload
   trigger = `(size, mtime)` or content hash, **not** mtime alone (two rewrites in
   one tick keep the stale key).
10. **Instance binding (`aud`) — random uuid, not a path hash.** The provisioned
    file holds `{ v:1, secret:"<32B hex>", instance:"<uuid4>" }`; the signed payload
    carries `aud = instance`, each side rejecting a mismatch. A **random uuid**, not
    `hash(<dataDir>)` — path hashing drags in canonicalization no one wants to own
    (trailing slash, symlinks, macOS case-fold, Windows short paths), all failing
    closed but debugging like a nightmare. The uuid gives the same binding property,
    zero path semantics, and survives moving the install dir. Closes cross-install
    replay when a provisioned secret is shared via copied dotfiles or a restored
    backup.
11. **Filename untrusted; reader binding asserted.** Everything keys off `payload.id`
    — the filename is metadata (ignore or reject on mismatch, never assume they
    agree). And the process reading a response MUST be the one that sent the command
    (it holds the request id); assert it, since a send/read split across runs would
    silently degrade the binding to "any valid response."

**Retained from the original review** (orthogonal, still required): id sanitization
to `[A-Za-z0-9_-]+` as a **reject, post-verify** (FIX-02); timing-safe HMAC compare;
rate limit (FIX-03, but **reject-not-defer**, item 8); action allowlist (FIX-10).
The full wire contract lives in §3.

### Addendum — item 12: SINGLE-WRITER on the bridge dir (WS3, 2026-07-16)

The dedup guarantee (item 8: INSERT-on-execute ⇒ replay is harmless) silently
assumes exactly one processor per bridge dir. WS3 live-tested two ways that
assumption breaks in `plugin.js`, both of which defeated dedup (a replayed id
executed 2–5×). See `super-productivity-ws3-findings.md` for full evidence.

1. **Tick re-entrancy (FIXED, v0.1.6).** `setInterval(tick,1000)` with an async
   tick that can exceed 1s and no in-flight guard ⇒ overlapping ticks both scan
   the same not-yet-deleted file and both dispatch before either inserts the
   dedup id. Fix: a `ticking` boolean guard released in `finally`.
2. **Loop multiplicity (MITIGATED; durable fix pending).** SP gives the plugin a
   fresh JS context per (re)load and doesn't reliably destroy the old iframe, so
   reloads ACCUMULATE tick loops (WS3 saw 3→6). N loops = N in-memory dedup sets
   racing on the shared on-disk dir; the per-loop guard can't help. Today's
   mitigation: full SP restart ⇒ one loop. **Durable fix (WS3.5): a bridge-dir
   `.bridge_lock`** holding `{pid, startedAt, heartbeatAt}`; a starting loop that
   sees a live heartbeat refuses to arm its interval, so exactly one loop polls
   regardless of reloads. The owner refreshes the heartbeat each tick; a stale
   lock is reclaimable after it ages out (~2× POLL_MS).

---

## 5. Workstreams / sequencing
- **WS0 — Transport decision spike: ✅ DONE (2026-07-15).** Decided **file-IPC +
  HMAC** (§1 rationale, §3 frozen seam, §4 hardened protocol). Evidence: file-IPC
  proven live (`check_connection` pong round-trip); SP is a native `/opt` install
  (not Flatpak) so no sandbox blocker; HTTP rejected because it forces an always-on
  daemon an ephemeral method can't be. `sendCommand` seam contract FROZEN. No
  invasive test needed (only the read-only `check_connection` ping was run).
- **WS0b — Codegen spike:** derive method/arg schemas (+ plugin handlers) from SP
  `plugin-api.ts` types. Decide hand-write-core-now vs generate-all.
- **WS1 — Seam + `sync` (read-only): DONE (2026-07-16).** Proved the authenticated
  handshake end-to-end. Plugin v0.1.5 stable. Key SP `executeNodeScript` findings:
  returns `{success, result, error, executionTime}` (not raw value); spawn path has
  E2BIG limit on args (use direct vm.runInContext for large payloads via fs/path/os-only
  scripts); `\n` in backtick templates must be `"\\n"`.
- **WS2 — Core writes: ✅ DONE (2026-07-16).** All 4 core write methods proven live
  against running SP v18.14.0: `notify` (524ms), `create_task` (1567ms),
  `update_task` (2078ms), `complete_task` (1069ms). All produce a `tasks` resource
  (auto-refresh after mutation). Test artifact: task `9VI0f0QzkkNSpcd_5U2DC`
  ("swamp WS2 UPDATED — delete me", done) in SP inbox.
- **WS3 — Adversarial live tests: ✅ DONE (2026-07-16).** All 7 cases pass
  against running SP (forged sig, replayed id, stale ts, reflection, aud
  mismatch, rate-limit, cross-key). Crypto/protocol layer solid on first pass.
  Found + fixed tick re-entrancy (plugin v0.1.6, `ticking` guard); found loop
  multiplicity across reloads (mitigated by SP restart). Full writeup:
  `super-productivity-ws3-findings.md`. See §4 addendum item 12.
- **WS3.5 — Single-writer lockfile (NEW, pending):** `.bridge_lock` heartbeat so
  only one tick loop polls regardless of plugin reloads. Closes defect 2 durably.
- **Cleanup:** remove debug instrumentation from plugin.js (`_debug_scan.log`,
  `_debug_tick.log`), rebuild zip, re-import into SP. **Deferred until after
  WS3.5** — the debug logs are the observation channel for verifying the lockfile.
- **WS4 — Breadth:** batchUpdateForProject, counters/time-tracking, trigger_sync,
  tag/project ops.
- **WS5 — Headless read path:** decrypt-and-read the sync file (Argon2id +
  AES-256-GCM / plain JSON) for app-closed bulk snapshots.
- **WS6 (fast-follow, Option 3) — TABLED, not committed.** SP→swamp events and
  `registerIssueProvider`. WS0 identified the clean carrier: `swamp serve --webhook`
  (inbound, HMAC-validated, triggers a workflow; `generic` scheme fits our
  signature) with the SP plugin `fetch`ing out — a swamp-native always-on listener,
  no bespoke daemon. **Parked:** with file-IPC maintained for commands, a second
  event channel is an addition that must earn its place, not a prerequisite.
  Revisit after WS1–WS2.

---

## 6. Why this fits swamp (for the record)
The MCP is *you-in-the-loop via Claude*. The swamp model makes SP a **node in the
automated graph** — headless from workflows/cron, wired via CEL. Grounded examples
against existing models: nts-sar monthly report done → `notify` or auto-complete
the "file NTS report" task; a deploy (forgejo) succeeds → create/complete an SP
task; a workflow gate reads `data.latest("sp","tasks")` and branches on a tag
filter. Complementary to the MCP, not redundant.

---

## 7. Key file/repo references
- SP source (ceiling): `~/dev/thirdparty/github.com/johannesjo/super-productivity`
  (v18.14.0) — `src/app/plugins/plugin-api.ts`, `plugin-api.model.ts`.
- Hardened fork + security review: `~/dev/shrug.pw/scratch/SP-MCP`
  (`SECURITY_REVIEW.md`, `HANDOFF.md`, `plugin.js`, `mcp_server.py`).
- Live b0x42 build: `~/.npm/_npx/6b48eba35c5edac0/node_modules/super-productivity-mcp`.
- Bridge dir (live): `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-mcp`.
- Extension patterns: `~/dev/swamp/extensions/models/plocate.ts` (reference model),
  `~/dev/swamp/extensions/docs/plocate-plan.md` (plan format).

---

## 8. Swamp conventions to honor (repo CLAUDE.md)
- Search registry/local types before building (done — no SP type exists).
- Extend-don't-be-clever; one method one purpose.
- CEL everywhere; `data.latest(...)` over deprecated `model.<name>.resource...`.
- Rule 6 fan-out (single execution for multi-target) — hence `sync`/`batch`.
- Extension npm deps are bundled; pin explicit `npm:` versions; `import { z } from "npm:zod@4"`.
- Don't `swamp extension push` until Neil reviews.

---

## 9. Open questions — resolved (upstream survey 2026-07-15) + remaining
**Resolved:**
1. ben-elliot @ 2.2.1: 16 tools, **localhost-HTTP daemon** (not file-IPC since
   v2.0.0), **no auth**, uses only a small fraction of the ceiling (no counters/
   dispatchAction/triggerSync/issue-provider; "time tracking" faked via updateTask).
2. b0x42: **independent build** (no parent), Node/TS, **file-IPC**, latest
   **v1.3.4**, **no auth**. Not a delta of the Python line.
3. Headless read: **viable** (AES-256-GCM + Argon2id, or plain JSON if encryption
   off; reimplementable, needs user password; read/export only). See §2.
4. No official/first-party bridge exists; none anointed. **Recommendation: roll
   our own plugin** (iFrame + localhost fetch + auth), don't adopt either upstream
   as a shared wire.

**Remaining:**
5. (Option 3) How much can a `registerIssueProvider` plugin actually manage /
   what's its control scope? Needs a source read of SP's issue-provider plugin
   contract before committing WS6.
6. ~~Confirm iFrame + localhost-fetch under Flatpak~~ **RESOLVED (WS0):** SP here is
   **not** Flatpak — native `/opt` Electron install, no sandbox. Moot for the chosen
   file-IPC transport; HTTP was also CSP-feasible (`connect-src *`) but rejected on
   the daemon-requirement grounds, not feasibility.
7. Exact per-argument JSON schemas of the plugin actions (names known; arg shapes
   to be enumerated from `plugin-api.ts` during WS0b codegen).
