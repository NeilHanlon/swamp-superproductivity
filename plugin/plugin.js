/* ─────────────────────────────────────────────────────────────────────────────
 * @kneel/super-productivity — SP-side bridge plugin (verifier half).
 *
 * This is the SP-plugin WRAPPER around the frozen wire (sp_wire.ts) and the tested
 * plugin loop (sp_plugin_core.ts). Those two TS files are the source of truth for
 * the logic and are unit-tested (23 tests); this file re-implements the SAME
 * algorithm inside SP's constraints and MUST stay in lockstep (codegen target).
 *
 * SP constraint that shapes the structure: crypto + filesystem are only available
 * in Node via `PluginAPI.executeNodeScript` (a stateless string eval), while the
 * SP capability calls (getTasks/addTask/notify/…) are only available in the iframe.
 * So each poll tick is three phases:
 *   1. Node  — scan plugin_commands/, verify (HMAC→parse→aud→freshness→id-charset),
 *              count-verified-only, rate-limit (reject-not-defer: sign+write
 *              rate_limited), dedup-check, allowlist. Returns the to-execute list;
 *              deletes rejected/rate-limited/forbidden/deduped files.
 *   2. iframe— dispatch each to-execute command through PluginAPI.
 *   3. Node  — sign each result/error with k_rsp, atomic-write the response, delete
 *              the command file. The iframe then inserts executed ids into dedup
 *              (INSERT ON EXECUTE, §4 item 8).
 *
 * State (processedIds map, recentVerified array) lives in the iframe and is passed
 * into/out of the stateless Node evals each tick.
 *
 * Bridge dir is OUR OWN (§ G2 decision): <HOME>/.var/app/…/super-productivity-swamp,
 * separate from b0x42's super-productivity-mcp — no shared-dir contention.
 * ───────────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  // Version STAMP (WS7a): build_plugin (super_productivity.ts) replaces this token
  // with plugin/manifest.json's version when it produces the canonical zip, so the
  // reported version cannot silently drift from the manifest (SWAMP-3). The literal
  // token survives in SOURCE (unit/parity tests run against source); only the built
  // artifact carries a real semver. plugin_status surfaces it as `version`.
  var PLUGIN_VERSION = "__PLUGIN_VERSION__";
  var BRIDGE_REL = ".var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp";
  var POLL_MS = 1000;
  var MAX_PER_MIN = 30;
  var DEDUP_RETENTION_MS = 120000; // window + skew
  var DEDUP_CAP = 500; // > MAX_PER_MIN × 2min
  var FRESHNESS_MS = 120000;
  // DATA verbs → dispatched through the SP PluginAPI (dispatch()). Locked in lockstep
  // with sp_plugin_core.DEFAULT_ALLOWED by the source-parity test (SWAMP-11).
  var ALLOWED = [
    "get_snapshot", "get_tasks", "get_current_task", "get_worklog",
    "create_task", "update_task", "complete_task", "notify",
    "plan_for_today", "remove_from_today",
    // WS4 breadth
    "batch", "delete_task", "log_time",
    "create_tag", "update_tag", "create_project", "update_project",
  ];
  // META (control-plane) verbs → dispatched against LOOP STATE (dispatchMeta()),
  // NEVER the PluginAPI. Rides the IDENTICAL §3/§4 verify pipeline + shared rate/
  // dedup budget as data; only the allowlist branch + dispatch target differ (WS7a).
  // Locked to sp_plugin_core.DEFAULT_META_ALLOWED by the parity test. Read-only today.
  var META_ALLOWED = ["plugin_status"];
  // A verb's class is decided by which list it is in; an overlap would make a signed
  // command's dispatch target ambiguous (SEC-1). Mirror the core's load-time assert.
  (function () {
    for (var i = 0; i < META_ALLOWED.length; i++) {
      if (ALLOWED.indexOf(META_ALLOWED[i]) >= 0) {
        throw new Error("sp-swamp: action '" + META_ALLOWED[i] + "' is in BOTH the data and meta allowlists");
      }
    }
  })();

  // ── WS3.5 single-writer lock (bridge-dir `.bridge_lock` heartbeat) ────────────
  // SP gives the plugin a FRESH JS context on every (re)load and does not reliably
  // tear down the prior iframe, so reloads ACCUMULATE tick loops (WS3 saw 3→6). N
  // loops = N in-memory dedup sets racing on ONE bridge dir → dedup breaks. The
  // per-loop `ticking` guard can't help across separate loops. The fix: a lockfile
  // at <dataDir>/.bridge_lock holding {owner,pid,startedAt,heartbeatAt}. Only the
  // loop that owns a FRESH lock arms its interval; every other loop idles and
  // watches (scheduleReclaim) so it can promote itself if the owner later dies.
  // The owner refreshes heartbeatAt each tick (folded into SCAN_SRC — no extra
  // spawn) and stands down the instant it sees the lock is no longer its own.
  var LOCK_STALE_MS = 3 * POLL_MS; // heartbeat older than this ⇒ owner is dead, reclaimable.
  //   Spec (plan §4 addendum) says ~2×POLL_MS; widened to 3× because a busy tick can
  //   run ~1.5–1.8s (defect-1 territory) and we must not judge a slow-but-live owner
  //   dead — that would briefly double-arm. The lockLost self-check is the backstop.
  var RECLAIM_MS = 5000; // idle (non-owner) loops re-check ownership this often (self-heal).
  var isOwner = false; // true only while THIS loop holds the lock and polls.
  var claiming = false; // start() re-entrancy guard (claim is async).
  var reclaimTimer = null; // pending scheduleReclaim() setTimeout handle.
  // ── WS7a observability state (surfaced by plugin_status, read-only) ───────────
  var ownedSinceMs = 0; // ms epoch this loop last ACQUIRED the lock; uptimeMs = now - this.
  //   Documented to RESET on reclaim/promotion — uptime is OWNERSHIP lifetime, not
  //   iframe lifetime (a promoted watcher starts a fresh ownership clock).
  var scanCount = 0; // successful SCAN_SRC passes in the CURRENT ownership epoch
  //   (reset alongside ownedSinceMs on every (re)acquire, so it tracks uptimeMs).
  var logLevel = "info"; // in-memory verbosity. NO bridge-reachable setter until WS7b
  //   adds set_log_level under its own META_ALLOWED gate (SEC-6) — reported only.
  // Per-loop identity: a fresh iframe context ⇒ a fresh LOOP_ID. This is what the
  // lock records as `owner`; pid is NOT unique (executeNodeScript loops may share
  // one Node backend process), so ownership is keyed on this token, not pid.
  var LOOP_ID = (function () {
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        var b = new Uint8Array(8); crypto.getRandomValues(b);
        return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      }
    } catch (e) {}
    return "l" + Math.floor(Math.random() * 1e9).toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  })();

  // Iframe-held state, round-tripped through the stateless Node evals.
  var state = { processedIds: {}, recentVerified: [] };
  var timer = null;
  // Re-entrancy guard: a full tick is ~9 sequential executeNodeScript spawns and
  // can exceed POLL_MS. Without this, setInterval fires a second tick while the
  // first is still in flight — both scan the same not-yet-deleted command file,
  // both pass the dedup check (id not yet inserted), and BOTH dispatch. That
  // defeats the §4-item-8 dedup guarantee (proven live in WS3). Serialize ticks.
  // (Still correct AND still needed with the lock: it guards IN-loop re-entrancy;
  // the lock guards ACROSS-loop multiplicity. Different failure modes.)
  var ticking = false;

  function log() {
    try { console.log.apply(console, ["[sp-swamp]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ── Phase 1 (Node): scan + verify + rate-limit + dedup-check + allowlist ──────
  // Mirrors sp_wire.verifyEnvelope + sp_plugin_core.processCommands (pre-dispatch).
  var SCAN_SRC = `
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const os = require('os');

    const cfg = args[0];                 // {bridgeRel, loopId, maxPerMin, retentionMs, cap, freshnessMs, allowed}
    const stateIn = args[1];             // {processedIds:{id:ts}, recentVerified:[ms]}
    const baseDir = path.join(os.homedir(), cfg.bridgeRel);
    const commandDir = path.join(baseDir, 'plugin_commands');
    const responseDir = path.join(baseDir, 'plugin_responses');
    const lockPath = path.join(baseDir, '.bridge_lock');
    const CMD_INFO = 'sp-ipc:command:v1', RSP_INFO = 'sp-ipc:response:v1';

    const out = { toExecute: [], rejected: [], rateLimited: [], deduped: [], authError: null, lockLost: false, lock: null,
                  state: { processedIds: Object.assign({}, stateIn.processedIds), recentVerified: stateIn.recentVerified.slice() } };

    // ── WS3.5 heartbeat + ownership self-check (single-writer) ──
    // Runs every tick in this already-open fs context (no extra spawn). If the lock
    // is missing or no longer owned by us, another loop has taken over (or it was
    // cleared) — we must NOT scan/dispatch: surface lockLost so tick() stands this
    // loop down. Otherwise refresh heartbeatAt (atomic tmp+rename) so peers keep
    // seeing us as alive and back off.
    {
      let lk = null;
      try { lk = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e) {}
      if (!lk || lk.owner !== cfg.loopId) { out.lockLost = true; return out; }
      lk.heartbeatAt = Date.now();
      try {
        const lt = lockPath + '.hb.' + cfg.loopId + '.tmp';
        fs.writeFileSync(lt, JSON.stringify(lk));
        fs.renameSync(lt, lockPath);
      } catch (e) {}
      // WS7a: thread the just-refreshed lock snapshot back so dispatchMeta can compute
      // an HONEST ageMs at dispatch time (age = now - heartbeatAt), not a stale one.
      out.lock = { owner: lk.owner, heartbeatAt: lk.heartbeatAt, startedAt: lk.startedAt };
    }

    function hexEqual(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      const ab = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
      if (ab.length !== bb.length) return false;
      return crypto.timingSafeEqual(ab, bb);
    }
    function subkey(secret, info) { return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(info).digest(); }
    function sign(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex'); }
    function del(p) { try { fs.unlinkSync(p); } catch (e) {} }
    function writeResp(secret, instance, id, ok, payloadExtra) {
      const obj = Object.assign({ v: 1, id: id, ts: Date.now(), aud: instance, ok: ok }, payloadExtra);
      const payload = JSON.stringify(obj);
      const env = JSON.stringify({ payload: payload, sig: sign(subkey(secret, RSP_INFO), payload) });
      const rp = path.join(responseDir, id + '_response.json');
      fs.writeFileSync(rp + '.tmp', env); fs.renameSync(rp + '.tmp', rp);
    }

    // Load the provisioned {v,secret,instance} (fail closed if missing).
    function dbgAuth(msg) { try { fs.writeFileSync(path.join(baseDir, '_debug_scan.json'), JSON.stringify({ ts: Date.now(), authError: msg, baseDir: baseDir })); } catch (e) {} }
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(baseDir, '.auth_token'), 'utf8')); }
    catch (e) { out.authError = 'missing or unreadable .auth_token'; dbgAuth(out.authError); return out; }
    if (!rec || typeof rec.secret !== 'string' || typeof rec.instance !== 'string') { out.authError = 'malformed .auth_token'; dbgAuth(out.authError); return out; }
    const kCmd = subkey(rec.secret, CMD_INFO);

    // Prune dedup (retention + cap).
    const now0 = Date.now();
    for (const id in out.state.processedIds) { if (out.state.processedIds[id] < now0 - cfg.retentionMs) delete out.state.processedIds[id]; }
    let ids = Object.keys(out.state.processedIds);
    if (ids.length > cfg.cap) {
      ids.sort((a, b) => out.state.processedIds[a] - out.state.processedIds[b]);
      for (let i = 0; i < ids.length - cfg.cap; i++) delete out.state.processedIds[ids[i]];
    }

    let files;
    try { files = fs.readdirSync(commandDir); } catch (e) {
      try { fs.appendFileSync(path.join(baseDir, '_debug_scan.log'), JSON.stringify({ts: Date.now(), error: 'readdir failed', dir: commandDir, err: String(e)}) + "\\n"); } catch (_) {}
      return out;
    }
    // DEBUG: log every scan with the directory path and file count
    try {
      fs.appendFileSync(path.join(baseDir, '_debug_scan.log'), JSON.stringify({
        ts: Date.now(), baseDir, commandDir, fileCount: files.length, files: files.slice(0, 5)
      }) + "\\n");
    } catch (e) {}
    for (const name of files) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const fp = path.join(commandDir, name);
      let env;
      try { env = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (e) { out.rejected.push({ name: name, reason: 'non-json' }); del(fp); continue; }

      // sp_wire.verifyEnvelope, direction=command, in FROZEN order.
      if (!env || typeof env.payload !== 'string' || typeof env.sig !== 'string') { out.rejected.push({ name: name, reason: 'malformed' }); del(fp); continue; }
      if (!hexEqual(sign(kCmd, env.payload), env.sig)) { out.rejected.push({ name: name, reason: 'bad-signature' }); del(fp); continue; } // NOT counted
      // HMAC passed → count toward the rate window (verified only).
      const now = Date.now();
      out.state.recentVerified.push(now);
      let p;
      try { p = JSON.parse(env.payload); } catch (e) { out.rejected.push({ name: name, reason: 'unparseable' }); del(fp); continue; }
      if (!p || typeof p !== 'object') { out.rejected.push({ name: name, reason: 'bad-shape' }); del(fp); continue; }
      if (p.v !== 1) { out.rejected.push({ name: name, reason: 'bad-version' }); del(fp); continue; }
      if (typeof p.id !== 'string' || typeof p.ts !== 'number') { out.rejected.push({ name: name, reason: 'bad-shape' }); del(fp); continue; }
      if (p.aud !== rec.instance) { out.rejected.push({ name: name, reason: 'aud-mismatch' }); del(fp); continue; }
      if (Math.abs(now - p.ts) > cfg.freshnessMs) { out.rejected.push({ name: name, reason: 'stale' }); del(fp); continue; }
      if (!/^[A-Za-z0-9_-]+$/.test(p.id)) { out.rejected.push({ name: name, reason: 'bad-id-charset' }); del(fp); continue; }

      // Rate limit (reject-not-defer). Prune 60s window then compare.
      out.state.recentVerified = out.state.recentVerified.filter((t) => t >= now - 60000);
      if (out.state.recentVerified.length > cfg.maxPerMin) {
        writeResp(rec.secret, rec.instance, p.id, false, { error: { code: 'rate_limited' } });
        out.rateLimited.push(p.id); del(fp); continue;
      }
      // Dedup CHECK (idempotent): already executed ⇒ skip + delete replay.
      if (Object.prototype.hasOwnProperty.call(out.state.processedIds, p.id)) { out.deduped.push(p.id); del(fp); continue; }
      // Allowlist + class decision (WS7a, mirrors sp_plugin_core.processCommands).
      // Decide the command's class ONCE here, where the fully-verified action is
      // available: data verbs → dispatch (PluginAPI), meta verbs → dispatchMeta
      // (loop state). Data is checked first, so a (load-asserted-impossible) overlap
      // routes deterministically to data. A verb in NEITHER list is forbidden.
      const isData = cfg.allowed.indexOf(p.action) >= 0;
      const isMeta = !isData && (cfg.metaAllowed || []).indexOf(p.action) >= 0;
      if (!isData && !isMeta) {
        writeResp(rec.secret, rec.instance, p.id, false, { error: { code: 'forbidden_action', action: p.action } });
        out.rejected.push({ name: name, reason: 'forbidden_action' }); del(fp); continue;
      }
      // Passed: hand to the iframe to dispatch, CARRYING the decided class so tick()
      // routes off the carried tag (no re-derivation). File deleted after response (phase 3).
      out.toExecute.push({ id: p.id, action: p.action, args: p.args || {}, file: name, cls: isData ? 'data' : 'meta' });
    }
    // DEBUG-G3: APPEND per-scan trace (one JSON object per line) so we don't lose
    // the scan that actually consumed the file. Overwrite was useless — the next
    // empty-dir scan wiped the evidence.
    try {
      const entry = {
        ts: Date.now(), filesSeen: files, rejected: out.rejected,
        toExecute: out.toExecute.map((c) => ({ id: c.id, action: c.action, file: c.file })),
        rateLimited: out.rateLimited, deduped: out.deduped, authError: out.authError,
        instanceSeen: rec.instance, nodeVersion: process.version,
      };
      fs.appendFileSync(path.join(baseDir, '_debug_scan.log'), JSON.stringify(entry) + "\\n");
      // Keep the latest-snapshot file too (convenient for quick peek), but only update
      // it when something INTERESTING happened (file seen, rejection, error).
      if (files.length > 0 || out.rejected.length > 0 || out.authError) {
        fs.writeFileSync(path.join(baseDir, '_debug_scan.json'), JSON.stringify(entry, null, 2));
      }
    } catch (e) {}
    return out;
  `;

  // ── Phase 3 (Node): sign + atomic-write responses, delete command files ───────
  // RESULTS are passed via a temp file (not as args) to avoid E2BIG when the result
  // is large (e.g. get_snapshot with thousands of tasks). The iframe writes the
  // results to _pending_results.json first, then WRITE_SRC reads from that file.
  var WRITE_SRC = `
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const os = require('os');
    const cfg = args[0];         // {bridgeRel}
    const baseDir = path.join(os.homedir(), cfg.bridgeRel);
    const commandDir = path.join(baseDir, 'plugin_commands');
    const responseDir = path.join(baseDir, 'plugin_responses');
    const RSP_INFO = 'sp-ipc:response:v1';
    function subkey(secret, info) { return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(info).digest(); }
    function sign(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex'); }
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(baseDir, '.auth_token'), 'utf8')); } catch (e) { return { ok: false, error: 'no token' }; }
    const kRsp = subkey(rec.secret, RSP_INFO);
    const resultsPath = path.join(baseDir, '_pending_results.json');
    let results;
    try { results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch (e) { return { ok: false, error: 'no results file: ' + e.message }; }
    const written = [];
    for (const r of results) {
      const obj = { v: 1, id: r.id, ts: Date.now(), aud: rec.instance, ok: !!r.ok };
      if (r.ok) obj.result = r.result; else obj.error = r.error;
      const payload = JSON.stringify(obj);
      const env = JSON.stringify({ payload: payload, sig: sign(kRsp, payload) });
      const rp = path.join(responseDir, r.id + '_response.json');
      try { fs.writeFileSync(rp + '.tmp', env); fs.renameSync(rp + '.tmp', rp); written.push(r.id); } catch (e) {}
      if (r.file) { try { fs.unlinkSync(path.join(commandDir, r.file)); } catch (e) {} }
    }
    try { fs.unlinkSync(resultsPath); } catch (e) {}
    return { ok: true, written: written };
  `;

  var scanCfg = {
    bridgeRel: BRIDGE_REL, loopId: LOOP_ID, maxPerMin: MAX_PER_MIN, retentionMs: DEDUP_RETENTION_MS,
    cap: DEDUP_CAP, freshnessMs: FRESHNESS_MS, allowed: ALLOWED, metaAllowed: META_ALLOWED,
  };

  // ── WS3.5 lock claim (Node): atomic single-writer acquisition ─────────────────
  // Called from start() BEFORE arming setInterval. Decides whether THIS loop may
  // poll. Returns {claimed:bool, reason, owner}. Correctness rests on two atomic
  // fs primitives — O_EXCL create (`wx`) and rename — never on read-then-write:
  //   • live lock owned by another loop  → claimed:false ('live-lock')  [duplicate]
  //   • lock already ours                → refresh + claimed:true       [re-adopt]
  //   • no lock                          → exclusive-create; winner claims
  //   • stale/corrupt lock               → rename it aside (exactly one loop wins
  //                                        the rename), then exclusive-create fresh
  // Two loops racing a free/stale lock can't both win: `wx` create fails EEXIST for
  // the loser, and rename-aside of one inode succeeds for exactly one caller.
  var CLAIM_SRC = `
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const cfg = args[0];                 // {bridgeRel, loopId, staleMs}
    const baseDir = path.join(os.homedir(), cfg.bridgeRel);
    const lockPath = path.join(baseDir, '.bridge_lock');
    const now = Date.now();
    // NO process.* here: this script requires only fs/path/os, so SP runs it in the
    // DIRECT vm.runInContext path (the E2BIG-avoidance path) where the process global
    // is NOT defined — touching process.pid throws ReferenceError, the claim fails
    // every tick, and openSync('wx') leaves an EMPTY lock (created before the throw).
    // Ownership is keyed on loopId (pid isn't unique across executeNodeScript loops
    // anyway), so pid was only informational — drop it entirely.
    const rec = () => JSON.stringify({ owner: cfg.loopId, startedAt: now, heartbeatAt: now });

    // {exists, parsed} — distinguishes absent (ENOENT) from present-but-corrupt.
    function statLock() {
      let raw;
      try { raw = fs.readFileSync(lockPath, 'utf8'); } catch (e) { return { exists: false, parsed: null }; }
      try { return { exists: true, parsed: JSON.parse(raw) }; } catch (e) { return { exists: true, parsed: null }; }
    }
    function createExclusive() {
      let fd;
      try { fd = fs.openSync(lockPath, 'wx'); } catch (e) { return false; } // EEXIST ⇒ someone beat us
      try { fs.writeSync(fd, rec()); } finally { fs.closeSync(fd); }
      return true;
    }

    const st = statLock();
    // Fresh lock held by a DIFFERENT loop → we are a duplicate; do not arm.
    if (st.exists && st.parsed && st.parsed.owner !== cfg.loopId
        && typeof st.parsed.heartbeatAt === 'number' && (now - st.parsed.heartbeatAt) < cfg.staleMs) {
      return { claimed: false, reason: 'live-lock', owner: st.parsed.owner, ageMs: now - st.parsed.heartbeatAt };
    }
    // Already ours (start() called twice in one context) → just refresh, keep polling.
    if (st.exists && st.parsed && st.parsed.owner === cfg.loopId) {
      try { const t = lockPath + '.' + cfg.loopId + '.tmp'; fs.writeFileSync(t, rec()); fs.renameSync(t, lockPath); } catch (e) {}
      return { claimed: true, reason: 're-adopt', owner: cfg.loopId };
    }
    // No lock at all → exclusive-create; loser of a simultaneous race falls through to re-read.
    if (!st.exists) {
      if (createExclusive()) return { claimed: true, reason: 'fresh', owner: cfg.loopId };
      const a = statLock();
      if (a.exists && a.parsed && a.parsed.owner === cfg.loopId) return { claimed: true, reason: 'fresh', owner: cfg.loopId };
      return { claimed: false, reason: 'lost-create', owner: a.parsed && a.parsed.owner };
    }
    // Stale or corrupt lock → reclaim: move it aside (only one loop wins the rename),
    // then exclusive-create a fresh one. A brand-new loop may create in the gap; if so
    // our createExclusive fails and we back off — still single-writer.
    const aside = lockPath + '.stale.' + cfg.loopId;
    try { fs.renameSync(lockPath, aside); }
    catch (e) { return { claimed: false, reason: 'lost-reclaim', error: String(e && e.message || e) }; }
    try { fs.unlinkSync(aside); } catch (e) {}
    if (createExclusive()) return { claimed: true, reason: 'reclaim-stale', owner: cfg.loopId };
    const a2 = statLock();
    if (a2.exists && a2.parsed && a2.parsed.owner === cfg.loopId) return { claimed: true, reason: 'reclaim-stale', owner: cfg.loopId };
    return { claimed: false, reason: 'lost-after-reclaim', owner: a2.parsed && a2.parsed.owner };
  `;

  // ── Phase 2 (iframe): dispatch one action through the SP PluginAPI ────────────
  // NOTE (G3): exact PluginAPI method names/shapes for get_current_task and
  // get_worklog need confirming against live SP v18.14.0. Marked TODO-G3.
  // "Today" in SP is NOT task.tagIds — it's task.dueDay (YYYY-MM-DD) PLUS the TODAY
  // tag's ordered taskIds (mirrors SP's handlePlanTasksForToday). Reproduce BOTH sides.
  function _todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  // Calendar-valid YYYY-MM-DD (mirrors SP's isValidDBDateStr). A bare regex accepts
  // 2026-06-31 / 2026-13-01, which as a timeSpentOnDay key would silently inflate the
  // derived timeSpent while never surfacing on any real calendar day in the worklog.
  function _isValidDayStr(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    var dt = new Date(y, mo - 1, d); // numeric ctor overflows; round-trip rejects it
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }
  function _uniq(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x && !seen[x]) { seen[x] = 1; out.push(x); }
    }
    return out;
  }
  // Copy only the keys that were actually supplied (undefined is omitted, but an
  // explicit null passes through — SP treats e.g. parentId:null as "detach").
  function _pick(obj, keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined) out[keys[i]] = obj[keys[i]];
    }
    return out;
  }
  async function _todayTagTaskIds() {
    var tags = await PluginAPI.getAllTags();
    for (var i = 0; i < tags.length; i++) if (tags[i].id === "TODAY") return tags[i].taskIds || [];
    return [];
  }
  async function planForToday(ids, day) {
    ids = _uniq(ids || []);
    if (!ids.length) return { planned: [], todayCount: (await _todayTagTaskIds()).length };
    var due = day || _todayStr();
    // Resolve subtask -> parent: SP lists only TOP-LEVEL tasks on the Today tag, so a
    // subtask id placed in TODAY.taskIds is silently dropped and the task never shows.
    // Anchor each id to its parent (mirrors SP handlePlanTasksForToday's parentTaskMap).
    var parentOf = {};
    var all = await PluginAPI.getTasks();
    for (var p = 0; p < all.length; p++) parentOf[all[p].id] = all[p].parentId || null;
    var anchors = _uniq(ids.map(function (id) { return parentOf[id] || id; }));
    var toDate = _uniq(ids.concat(anchors)); // set dueDay on planned tasks AND parent anchors
    for (var i = 0; i < toDate.length; i++) await PluginAPI.updateTask(toDate[i], { dueDay: due });
    var merged = _uniq(anchors.concat(await _todayTagTaskIds())); // top-level anchors, new first
    await PluginAPI.updateTag("TODAY", { taskIds: merged });
    return { planned: ids, anchors: anchors, dueDay: due, todayCount: merged.length };
  }
  async function removeFromToday(ids, clearDueDay) {
    ids = _uniq(ids || []);
    var drop = {};
    ids.forEach(function (x) { drop[x] = 1; });
    var kept = (await _todayTagTaskIds()).filter(function (x) { return !drop[x]; });
    await PluginAPI.updateTag("TODAY", { taskIds: kept });
    if (clearDueDay) for (var i = 0; i < ids.length; i++) await PluginAPI.updateTask(ids[i], { dueDay: null });
    return { removed: ids, todayCount: kept.length };
  }

  // Fetch a task by id from live state; throw if it doesn't exist (or is archived).
  // SP's updateTask/deleteTask SILENTLY no-op on an unknown id, so a caller passing a
  // stale/wrong id would otherwise get a false success and no mutation (the "dings but
  // task never checked off" bug). Guarding turns that into a clear error. Returns the task.
  async function _requireTask(id, op) {
    var all = await PluginAPI.getTasks(); // includes subtasks; excludes archived
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) return all[i]; }
    throw new Error(op + ": task not found (or archived): " + id);
  }

  async function dispatch(action, a) {
    switch (action) {
      case "get_snapshot":
        return {
          tasks: await PluginAPI.getTasks(),
          projects: await PluginAPI.getAllProjects(),
          tags: await PluginAPI.getAllTags(),
        };
      case "get_tasks":
        return a.includeArchived
          ? (await PluginAPI.getTasks()).concat(await PluginAPI.getArchivedTasks())
          : await PluginAPI.getTasks();
      case "get_current_task": { // TODO-G3: confirm the right accessor
        var sel = PluginAPI.getSelectedTask ? await PluginAPI.getSelectedTask() : null;
        return sel || null;
      }
      case "get_worklog": { // TODO-G3: derive from counters/getAppState; provisional
        var tasks = await PluginAPI.getTasks();
        return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, timeSpent: t.timeSpent })) };
      }
      case "create_task": {
        var data = { title: a.title };
        if (a.projectId) data.projectId = a.projectId;
        if (a.tagIds) data.tagIds = a.tagIds;
        if (a.notes) data.notes = a.notes;
        if (a.timeEstimate) data.timeEstimate = a.timeEstimate;
        // parentId ⇒ SP routes through addSubTask; the subtask inherits the parent's
        // project/tags (any projectId/tagIds above are ignored for subtasks by SP).
        if (a.parentId) data.parentId = a.parentId;
        var id = await PluginAPI.addTask(data);
        if (a.addToToday) await planForToday([id], a.dueDay); // opt-in: put the new task on Today
        return { id: id, addedToToday: !!a.addToToday };
      }
      case "update_task": {
        await _requireTask(a.taskId, "update_task"); // stale id ⇒ error, not silent no-op
        var patch = {};
        ["title", "notes", "projectId", "tagIds", "timeEstimate", "isDone", "dueDay"].forEach(function (k) {
          if (a[k] !== undefined) patch[k] = a[k];
        });
        // TODAY is a meta-tag (dueDay + TODAY tag.taskIds), NOT task.tagIds. If a caller
        // lists it in tagIds it would silently no-op, so strip it and honor the intent.
        var wantsToday = Array.isArray(patch.tagIds) && patch.tagIds.indexOf("TODAY") !== -1;
        if (wantsToday) patch.tagIds = patch.tagIds.filter(function (t) { return t !== "TODAY"; });
        await PluginAPI.updateTask(a.taskId, patch);
        if (wantsToday) await planForToday([a.taskId], patch.dueDay);
        return { updated: a.taskId, planned: wantsToday };
      }
      case "plan_for_today":
        return await planForToday(a.taskIds || (a.taskId ? [a.taskId] : []), a.dueDay);
      case "remove_from_today":
        return await removeFromToday(a.taskIds || (a.taskId ? [a.taskId] : []), !!a.clearDueDay);
      case "complete_task":
        await _requireTask(a.taskId, "complete_task"); // stale id ⇒ error, not silent no-op
        await PluginAPI.updateTask(a.taskId, { isDone: true, doneOn: Date.now() });
        return { completed: a.taskId };
      // Log/adjust time on a task for a given day. SP's canonical unit is `timeSpentOnDay`
      // (a { "YYYY-MM-DD": ms } map); derived `timeSpent` recomputes in SP's reducer. The
      // write is ABSOLUTE (SP overwrites the whole map), so to ADD we read live state right
      // before writing (plugin-side RMW, minimal TOCTOU) and merge. mode:'add' (default)
      // increments the day; mode:'set' overwrites it. Never write `timeSpent` directly.
      case "log_time": {
        if (a.date !== undefined && a.date !== null && !_isValidDayStr(a.date)) {
          throw new Error("log_time: invalid calendar date: " + a.date);
        }
        var date = a.date || _todayStr();
        var t = await _requireTask(a.taskId, "log_time");
        var spentOnDay = (t.timeSpentOnDay && typeof t.timeSpentOnDay === "object")
          ? Object.assign({}, t.timeSpentOnDay) : {};
        var prev = +spentOnDay[date] || 0;
        var next = a.mode === "set" ? a.durationMs : prev + a.durationMs;
        if (!isFinite(next)) throw new Error("log_time: non-finite duration");
        if (next < 0) next = 0;                          // negative day-time is invalid
        spentOnDay[date] = next;
        await PluginAPI.updateTask(a.taskId, { timeSpentOnDay: spentOnDay });
        return { taskId: a.taskId, date: date, previousMs: prev, newMs: next, mode: a.mode || "add" };
      }
      case "notify":
        await PluginAPI.notify({ title: a.title, body: a.body || "" });
        return { notified: true };
      // ── WS4 breadth ─────────────────────────────────────────────────────────
      case "batch": {
        // ONE dispatch, N structural ops within a.projectId. SP returns
        // {success, createdTaskIds:{tempId:realId}, errors?[]}. Pass the shape
        // straight through — the model surfaces it as the batchResult resource.
        var batchRes = await PluginAPI.batchUpdateForProject({
          projectId: a.projectId,
          operations: a.operations || [],
        });
        return {
          success: !!(batchRes && batchRes.success),
          createdTaskIds: (batchRes && batchRes.createdTaskIds) || {},
          errors: (batchRes && batchRes.errors) || [],
        };
      }
      case "delete_task":
        await _requireTask(a.taskId, "delete_task"); // stale id ⇒ error, not silent no-op
        await PluginAPI.deleteTask(a.taskId);
        return { deleted: a.taskId };
      case "create_tag": {
        var tagId = await PluginAPI.addTag(_pick(a, ["title", "color", "icon"]));
        return { id: tagId };
      }
      case "update_tag":
        await PluginAPI.updateTag(a.tagId, _pick(a, ["title", "color", "icon"]));
        return { updated: a.tagId };
      case "create_project": {
        var projId = await PluginAPI.addProject(_pick(a, ["title"]));
        return { id: projId };
      }
      case "update_project":
        await PluginAPI.updateProject(a.projectId, _pick(a, ["title", "isArchived", "isHiddenFromMenu"]));
        return { updated: a.projectId };
      default:
        throw new Error("unknown action: " + action);
    }
  }

  // ── Meta (control-plane) dispatch (WS7a) ──────────────────────────────────────
  // Routed here ONLY for verbs in META_ALLOWED (decided at the SCAN_SRC allowlist
  // step, carried as cls:'meta'). Reads ONLY in-context LOOP STATE — never the
  // PluginAPI, never fs. `lockSnap` is the per-tick heartbeat snapshot threaded from
  // SCAN_SRC; ageMs is computed HERE, at dispatch time, so freshness is honest even
  // if the tick was slow (SEC-8). Read-only today; WS7b/WS7c add mutating verbs.
  async function dispatchMeta(action, args, lockSnap) {
    switch (action) {
      case "plugin_status": {
        var now = Date.now();
        var hb = (lockSnap && typeof lockSnap.heartbeatAt === "number") ? lockSnap.heartbeatAt : null;
        var ageMs = hb != null ? (now - hb) : null;
        return {
          version: PLUGIN_VERSION,
          loopId: LOOP_ID,
          // Always true today: only the lock owner ever dispatches, so a plugin_status
          // that runs at all runs in the owner. Kept for WS7c multi-loop symmetry.
          isOwner: isOwner,
          uptimeMs: ownedSinceMs ? (now - ownedSinceMs) : 0,
          scanCount: scanCount,
          pollMs: POLL_MS,
          logLevel: logLevel,
          lock: {
            owner: lockSnap ? (lockSnap.owner || null) : null,
            heartbeatAt: hb,
            ageMs: ageMs,
            stale: ageMs != null ? (ageMs > LOCK_STALE_MS) : true,
          },
        };
      }
      default:
        throw new Error("unknown meta action: " + action);
    }
  }

  // iframe-land has no fs — every debug write goes through executeNodeScript.
  function dbgAppend(entry) {
    var src = "const fs = require('fs'); const path = require('path'); const os = require('os');" +
      "const baseDir = path.join(os.homedir(), args[0].bridgeRel);" +
      "try { fs.appendFileSync(path.join(baseDir, '_debug_tick.log'), JSON.stringify(args[0].entry) + '\\n'); } catch (e) {}";
    try {
      PluginAPI.executeNodeScript({ script: src, args: [{ bridgeRel: BRIDGE_REL, entry: entry }], timeout: 5000 });
    } catch (e) {
      log("dbgAppend failed:", e && e.message || e);
    }
  }

  async function tick() {
    if (ticking) return; // a prior tick is still in flight; skip this interval
    ticking = true;
    try {
      var scan = await PluginAPI.executeNodeScript({ script: SCAN_SRC, args: [scanCfg, state], timeout: 10000 });
      dbgAppend({ phase: "scan_return", success: scan && scan.success, hasResult: !!(scan && scan.result), error: scan && scan.error, execTime: scan && scan.executionTime });
      var r = scan && scan.success ? scan.result : null;
      if (!r) { dbgAppend({ phase: "scan_empty" }); return; }
      // WS3.5: the lock is no longer ours (a peer reclaimed it, or it was cleared).
      // Stand this loop down immediately — do NOT adopt state, scan, or dispatch.
      // Demote to a watcher that can re-promote if the new owner later dies.
      if (r.lockLost) {
        log("bridge lock lost/superseded — standing down this loop (" + LOOP_ID + ")");
        dbgAppend({ phase: "lock_lost", loopId: LOOP_ID });
        standDown();
        return;
      }
      scanCount += 1; // WS7a: a successful owned scan (surfaced by plugin_status)
      if (r.state) state = r.state; // adopt updated rate/dedup state
      if (r.authError) { log("auth:", r.authError); dbgAppend({ phase: "auth_error", msg: r.authError }); return; }
      if (r.rejected && r.rejected.length) log("rejected", r.rejected.length, r.rejected.map(function (x) { return x.reason; }));
      if (r.rateLimited && r.rateLimited.length) log("rate_limited", r.rateLimited.length);

      var toExec = r.toExecute || [];
      dbgAppend({ phase: "scan_result", toExecute: toExec.map(function (c) { return { id: c.id, action: c.action }; }), rejected: r.rejected, deduped: r.deduped, rateLimited: r.rateLimited });
      if (!toExec.length) return;

      var results = [];
      for (var i = 0; i < toExec.length; i++) {
        var c = toExec[i];
        try {
          // Route off the CARRIED class (decided at the SCAN_SRC allowlist step) —
          // a trivial tag-switch, no re-derivation. meta → loop state, data → PluginAPI.
          var res = c.cls === "meta"
            ? await dispatchMeta(c.action, c.args, r.lock)
            : await dispatch(c.action, c.args);
          results.push({ id: c.id, file: c.file, ok: true, result: res });
          dbgAppend({ phase: "dispatch_ok", id: c.id, action: c.action, cls: c.cls, result: res });
        } catch (e) {
          var errMsg = String(e && e.message || e);
          results.push({ id: c.id, file: c.file, ok: false, error: { code: "exec_failed", message: errMsg } });
          dbgAppend({ phase: "dispatch_err", id: c.id, action: c.action, error: errMsg });
        }
        // Dedup INSERT ON EXECUTE (§4 item 8) — regardless of ok/error, it ran.
        state.processedIds[c.id] = Date.now();
      }
      // Stage results to a file BEFORE calling WRITE_SRC (avoids E2BIG on large payloads).
      var stageSrc = "const fs = require('fs'); const path = require('path'); const os = require('os');" +
        "const baseDir = path.join(os.homedir(), args[0].bridgeRel);" +
        "const resultsPath = path.join(baseDir, '_pending_results.json');" +
        "try { fs.writeFileSync(resultsPath, JSON.stringify(args[0].results)); return { ok: true }; }" +
        "catch (e) { return { ok: false, error: String(e.message || e) }; }";
      var stageRes = await PluginAPI.executeNodeScript({ script: stageSrc, args: [{ bridgeRel: BRIDGE_REL, results: results }], timeout: 10000 });
      dbgAppend({ phase: "stage_return", stageRes: stageRes });
      if (!stageRes || !stageRes.success || !(stageRes.result && stageRes.result.ok)) {
        dbgAppend({ phase: "stage_failed", stageRes: stageRes });
        return;
      }
      var writeRes = await PluginAPI.executeNodeScript({ script: WRITE_SRC, args: [{ bridgeRel: BRIDGE_REL }], timeout: 10000 });
      dbgAppend({ phase: "write_return", writeRes: writeRes });
      log("executed", results.length);
    } catch (e) {
      var msg = String(e && e.message || e);
      log("tick error:", msg);
      dbgAppend({ phase: "tick_error", error: msg });
    } finally {
      ticking = false; // release the guard even on error/early-return
    }
  }

  // Stop polling and become an idle watcher. Called when we discover the lock is no
  // longer ours (lockLost). We keep watching so that if the current owner's iframe
  // dies, this lingering loop promotes itself after the lock ages out.
  function standDown() {
    if (timer) { clearInterval(timer); timer = null; }
    isOwner = false;
    scheduleReclaim();
  }

  // Idle (non-owner) loops re-attempt the claim every RECLAIM_MS. This is what makes
  // the system self-healing: whichever iframe SP happens to tear down, a surviving
  // loop takes over once the dead owner's heartbeat goes stale — no manual reload.
  function scheduleReclaim() {
    if (timer || reclaimTimer) return; // already polling, or a watcher is already armed
    reclaimTimer = setTimeout(function () {
      reclaimTimer = null;
      if (timer) return; // became owner via another path
      start();
    }, RECLAIM_MS);
  }

  // Acquire the single-writer lock, THEN (and only then) arm the poll interval.
  // A loop that loses the claim never arms — it idles and watches. This is the
  // durable fix for loop multiplicity across plugin reloads (WS3.5).
  async function start() {
    if (timer || claiming) return;
    claiming = true;
    try {
      log("starting; bridge:", BRIDGE_REL, "loop:", LOOP_ID);
      var res = await PluginAPI.executeNodeScript({
        script: CLAIM_SRC,
        args: [{ bridgeRel: BRIDGE_REL, loopId: LOOP_ID, staleMs: LOCK_STALE_MS }],
        timeout: 10000,
      });
      var claim = res && res.success ? res.result : null;
      dbgAppend({ phase: "lock_claim", claim: claim, ok: !!(res && res.success), err: res && res.error });
      if (!claim || !claim.claimed) {
        // Duplicate loop (or transient claim failure) → do NOT arm. Watch instead.
        isOwner = false;
        log("bridge lock not acquired (" + (claim ? claim.reason + "; owner " + claim.owner : "claim failed") + ") — idling, will re-check in " + RECLAIM_MS + "ms");
        scheduleReclaim();
        return;
      }
      isOwner = true;
      ownedSinceMs = Date.now(); // WS7a: start this ownership's uptime clock (resets on promotion)
      scanCount = 0; // reset with the uptime clock so both count from this acquisition
      if (reclaimTimer) { clearTimeout(reclaimTimer); reclaimTimer = null; }
      log("bridge lock acquired (" + claim.reason + ") — arming poll interval");
      dbgAppend({ phase: "lock_acquired", reason: claim.reason, loopId: LOOP_ID });
      timer = setInterval(tick, POLL_MS);
      tick();
    } catch (e) {
      // Fail toward fewer pollers, but keep retrying so we don't leave the bridge
      // dead if this was the only/first loop and the claim spawn hiccuped.
      log("lock claim error:", String(e && e.message || e));
      dbgAppend({ phase: "lock_claim_error", error: String(e && e.message || e) });
      scheduleReclaim();
    } finally {
      claiming = false;
    }
  }

  if (typeof PluginAPI !== "undefined") start();
  else window.addEventListener("DOMContentLoaded", function () {
    if (typeof PluginAPI !== "undefined") start(); else log("PluginAPI unavailable");
  });
})();
