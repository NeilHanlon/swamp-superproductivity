// Adversarial tests for the plugin's stateful loop (§4 items 8 & FIX-10).
//   ~/.swamp/deno/deno test extensions/super-productivity/sp_plugin_core_test.ts --allow-read
//
// These are the WS3 hardening properties, built in from day one: dedup-on-execute,
// count-verified-only, reject-not-defer, unverified-flood starvation resistance,
// and the action allowlist — plus a check that emitted responses are genuinely
// model-verifiable (closes the loop through sp_wire).

import { strict as assert } from "node:assert";
import {
  type AuthRecord,
  buildCommandEnvelope,
  type Envelope,
  mintId,
  type ResponsePayload,
  verifyEnvelope,
} from "./sp_wire.ts";
import {
  assertDisjointAllowlists,
  DEFAULT_ALLOWED,
  DEFAULT_META_ALLOWED,
  defaultConfig,
  newState,
  type PluginIO,
  processCommands,
  type RawFile,
} from "./sp_plugin_core.ts";

const NOW = 1_700_000_000_000;
const auth: AuthRecord = {
  v: 1,
  secret: "c".repeat(64),
  instance: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

// Build a raw command file (name + serialized envelope).
function rawCmd(
  action: string,
  args: Record<string, unknown> = {},
  overrides: { id?: string; ts?: number; signAuth?: AuthRecord } = {},
): RawFile {
  const id = overrides.id ?? mintId();
  const env = buildCommandEnvelope(overrides.signAuth ?? auth, {
    id,
    ts: overrides.ts ?? NOW,
    action,
    args,
  });
  return { name: `${id}.json`, content: JSON.stringify(env) };
}

// A recording IO harness. `dispatch` counts calls; `writeResponse` collects
// envelopes; `deleteFile` collects names.
function harness(nowVal = NOW) {
  const responses: Array<{ id: string; env: Envelope }> = [];
  const deleted: string[] = [];
  let dispatchCalls = 0;
  let dispatchMetaCalls = 0;
  const io: PluginIO = {
    now: () => nowVal,
    dispatch: (action) => {
      dispatchCalls += 1;
      return Promise.resolve({ ok: action });
    },
    dispatchMeta: (action) => {
      dispatchMetaCalls += 1;
      return Promise.resolve({ meta: action });
    },
    writeResponse: (id, env) => {
      responses.push({ id, env });
      return Promise.resolve();
    },
    deleteFile: (name) => {
      deleted.push(name);
      return Promise.resolve();
    },
  };
  return {
    io,
    responses,
    deleted,
    get dispatchCalls() {
      return dispatchCalls;
    },
    get dispatchMetaCalls() {
      return dispatchMetaCalls;
    },
  };
}

Deno.test("valid command executes once and emits a model-verifiable response", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("get_tasks");
  const id = cmd.name.replace(".json", "");
  const sum = await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.deepEqual(sum.executed, [id]);
  assert.equal(h.dispatchCalls, 1);
  assert.equal(state.processedIds.has(id), true); // dedup inserted on execute
  assert.equal(h.deleted.includes(cmd.name), true);

  // The response the plugin wrote must verify under the RESPONSE subkey + bind id.
  assert.equal(h.responses.length, 1);
  const v = verifyEnvelope<ResponsePayload>(
    auth,
    h.responses[0].env,
    "response",
    {
      nowMs: NOW,
      expectId: id,
    },
  );
  assert.equal(v.ok, true);
  assert.equal(v.payload?.ok, true);
});

Deno.test("replayed id is deduped — executes exactly once (§4.2/§4.8)", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("get_tasks");
  const id = cmd.name.replace(".json", "");
  // Same signed bytes presented twice (attacker copy-to-new-filename, same id).
  const replay: RawFile = { name: `copy-${cmd.name}`, content: cmd.content };

  await processCommands(auth, defaultConfig(), state, [cmd], h.io);
  const sum2 = await processCommands(
    auth,
    defaultConfig(),
    state,
    [replay],
    h.io,
  );

  assert.equal(h.dispatchCalls, 1); // NOT executed again
  assert.deepEqual(sum2.deduped, [id]);
});

Deno.test("forged signature: rejected, not counted (starvation guard §4.8)", async () => {
  const h = harness();
  const state = newState();
  const forged = rawCmd("get_tasks", {}, {
    signAuth: { ...auth, secret: "9".repeat(64) },
  });
  const sum = await processCommands(
    auth,
    defaultConfig(),
    state,
    [forged],
    h.io,
  );

  assert.equal(h.dispatchCalls, 0);
  assert.equal(state.recentVerified.length, 0); // did NOT consume rate budget
  assert.equal(sum.rejected[0].reason, "bad-signature");
  assert.equal(h.responses.length, 0); // never sign a response to unverified input
});

Deno.test("unverified flood does not starve legit commands (§4.8)", async () => {
  const h = harness();
  const cfg = { ...defaultConfig(), maxCommandsPerMinute: 3 };
  const state = newState();
  const forgedAuth = { ...auth, secret: "9".repeat(64) };
  const flood: RawFile[] = [];
  for (let i = 0; i < 100; i++) {
    flood.push(rawCmd("get_tasks", {}, { signAuth: forgedAuth }));
  }
  const legit = [rawCmd("get_tasks"), rawCmd("get_tasks"), rawCmd("get_tasks")];

  const sum = await processCommands(
    auth,
    cfg,
    state,
    [...flood, ...legit],
    h.io,
  );
  assert.equal(sum.executed.length, 3); // all 3 legit ran despite 100 forged
  assert.equal(h.dispatchCalls, 3);
});

Deno.test("stale command is counted but not executed (§4.1)", async () => {
  const h = harness();
  const state = newState();
  const stale = rawCmd("get_tasks", {}, { ts: NOW - 200_000 });
  const sum = await processCommands(
    auth,
    defaultConfig(),
    state,
    [stale],
    h.io,
  );

  assert.equal(h.dispatchCalls, 0);
  assert.equal(state.recentVerified.length, 1); // provenance held → counted
  assert.equal(sum.rejected[0].reason, "stale");
});

Deno.test("reject-not-defer: over budget ⇒ signed rate_limited, no dedup insert (§4.8)", async () => {
  const h = harness();
  const cfg = { ...defaultConfig(), maxCommandsPerMinute: 3 };
  const state = newState();
  const cmds = [0, 1, 2, 3, 4].map(() => rawCmd("get_tasks"));

  const sum = await processCommands(auth, cfg, state, cmds, h.io);
  assert.equal(sum.executed.length, 3); // budget = maxPerMinute
  assert.equal(sum.rateLimited.length, 2);

  // Rate-limited ids are signed responses AND absent from the dedup set (never ran).
  for (const id of sum.rateLimited) {
    assert.equal(state.processedIds.has(id), false);
    const resp = h.responses.find((r) => r.id === id);
    assert.ok(resp, "rate_limited response must be written");
    const v = verifyEnvelope<ResponsePayload>(auth, resp!.env, "response", {
      nowMs: NOW,
      expectId: id,
    });
    assert.equal(v.ok, true);
    assert.equal((v.payload?.error as { code: string }).code, "rate_limited");
  }
});

Deno.test("disallowed action is rejected with a signed error, not executed (§4 FIX-10)", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("dispatchAction", { type: "EVIL" });
  const id = cmd.name.replace(".json", "");
  const sum = await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.equal(h.dispatchCalls, 0);
  assert.equal(sum.rejected[0].reason, "forbidden_action");
  assert.equal(state.processedIds.has(id), false);
  const resp = h.responses.find((r) => r.id === id);
  assert.ok(resp);
  const v = verifyEnvelope<ResponsePayload>(auth, resp!.env, "response", {
    nowMs: NOW,
    expectId: id,
  });
  assert.equal((v.payload?.error as { code: string }).code, "forbidden_action");
});

Deno.test("aud mismatch (cross-install) is counted but dropped, unsigned (§4.10)", async () => {
  const h = harness();
  const state = newState();
  // Same secret, different instance uuid → HMAC passes, aud fails.
  const other = { ...auth, instance: "00000000-0000-4000-8000-000000000000" };
  const cmd = rawCmd("get_tasks", {}, { signAuth: other });
  const sum = await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.equal(h.dispatchCalls, 0);
  assert.equal(sum.rejected[0].reason, "aud-mismatch");
  assert.equal(h.responses.length, 0);
});

// ── WS7a: meta-command channel routing invariants ───────────────────────────

Deno.test("WS7a: a meta verb routes to dispatchMeta, NOT dispatch", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("plugin_status");
  const id = cmd.name.replace(".json", "");
  const sum = await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.deepEqual(sum.executed, [id]);
  assert.equal(h.dispatchMetaCalls, 1); // routed to the meta handler
  assert.equal(h.dispatchCalls, 0); // never touched PluginAPI dispatch
  // Response is a normal signed, model-verifiable success envelope.
  const v = verifyEnvelope<ResponsePayload>(
    auth,
    h.responses[0].env,
    "response",
    {
      nowMs: NOW,
      expectId: id,
    },
  );
  assert.equal(v.payload?.ok, true);
});

Deno.test("WS7a: a data verb routes to dispatch, NOT dispatchMeta", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("get_tasks");
  await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.equal(h.dispatchCalls, 1);
  assert.equal(h.dispatchMetaCalls, 0); // a data verb never reaches the meta handler
});

Deno.test("WS7a: a verb in neither allowlist is forbidden_action (no dispatch, no meta)", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("set_log_level"); // a future meta verb, not yet allowed
  const sum = await processCommands(auth, defaultConfig(), state, [cmd], h.io);

  assert.equal(h.dispatchCalls, 0);
  assert.equal(h.dispatchMetaCalls, 0);
  assert.equal(sum.rejected[0].reason, "forbidden_action");
});

Deno.test("WS7a: meta commands share the rate/dedup budget (replay deduped)", async () => {
  const h = harness();
  const state = newState();
  const cmd = rawCmd("plugin_status");
  const id = cmd.name.replace(".json", "");
  const replay: RawFile = { name: `copy-${cmd.name}`, content: cmd.content };

  await processCommands(auth, defaultConfig(), state, [cmd], h.io);
  assert.equal(state.recentVerified.length, 1); // meta counts toward the shared window
  const sum2 = await processCommands(
    auth,
    defaultConfig(),
    state,
    [replay],
    h.io,
  );

  assert.equal(h.dispatchMetaCalls, 1); // NOT executed again
  assert.deepEqual(sum2.deduped, [id]);
});

Deno.test("WS7a: assertDisjointAllowlists throws on an overlapping verb", () => {
  assert.throws(
    () =>
      assertDisjointAllowlists(
        new Set(["get_tasks", "plugin_status"]),
        new Set(["plugin_status"]),
      ),
    /BOTH the data and meta allowlists/,
  );
  // The shipped defaults are disjoint (also asserted at module load).
  assertDisjointAllowlists(DEFAULT_ALLOWED, DEFAULT_META_ALLOWED);
});

// ── WS7a / SWAMP-11: source-parity lock (plugin.js ⇔ core allowlists) ─────────
// plugin.js re-implements the core loop inside SP's constraints; the two allowlists
// MUST stay in lockstep or a verb's class/dispatch target silently diverges between
// the tested core and the shipped plugin. This robustly extracts plugin.js's ALLOWED
// / META_ALLOWED literals — tolerating inline comments and trailing commas by pulling
// only the double-quoted string tokens inside the bracketed literal (NO eval of plugin
// source) — and asserts each is NON-EMPTY and set-equal to the core default.

// Extract a single-level `var NAME = [ "a", "b", ... ]` string-array literal from JS
// source. Word-boundary-anchored so ALLOWED does not match inside META_ALLOWED; line
// comments are stripped before collecting quoted tokens so a commented-out verb can't
// sneak in. Throws if the literal is absent (catches an accidental rename/removal).
function extractJsStringArray(src: string, name: string): string[] {
  const m = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(src);
  if (!m) throw new Error(`plugin.js: array literal '${name}' not found`);
  const open = src.indexOf("[", m.index);
  if (open < 0) throw new Error(`plugin.js: '${name}' has no '['`);
  // Strip line comments from the remainder FIRST, so a ']' inside an inline comment
  // (e.g. `"batch", // see rule[9]`) can't truncate the body early. Verb names are
  // simple identifiers with no '//', so comment-stripping never eats a real token.
  const rest = src.slice(open + 1).replace(/\/\/[^\n]*/g, "");
  const close = rest.indexOf("]");
  if (close < 0) throw new Error(`plugin.js: '${name}' bracket unbalanced`);
  return [...rest.slice(0, close).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// Extract the `case "X":` labels inside a named function body in plugin.js (from
// `function <fn>(` to the next top-level `function `). Used to lock the allowlists to
// the actual dispatch/dispatchMeta switch arms — an allowlisted verb with no handler
// (or a handler with no allowlist entry) is a runtime `unknown action` waiting to ship.
function extractSwitchCases(src: string, fnName: string): string[] {
  const start = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(src);
  if (!start) throw new Error(`plugin.js: function '${fnName}' not found`);
  const after = src.slice(start.index + start[0].length);
  const nextFn = after.search(/\n\s*(?:async\s+)?function\s/);
  const body = nextFn >= 0 ? after.slice(0, nextFn) : after;
  return [...body.matchAll(/case\s+"([^"]+)"\s*:/g)].map((x) => x[1]);
}

Deno.test("WS7a/SWAMP-11: plugin.js ALLOWED == core DEFAULT_ALLOWED (non-empty, exact)", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  const pluginAllowed = extractJsStringArray(src, "ALLOWED");
  assert.ok(pluginAllowed.length > 0, "plugin.js ALLOWED must be non-empty");
  // exact set-equality with the core (order-independent, duplicate-sensitive count).
  assert.deepEqual(
    [...pluginAllowed].sort(),
    [...DEFAULT_ALLOWED].sort(),
    "plugin.js ALLOWED drifted from sp_plugin_core.DEFAULT_ALLOWED",
  );
});

Deno.test("WS7a/SWAMP-11: plugin.js META_ALLOWED == core DEFAULT_META_ALLOWED (non-empty, exact)", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  const pluginMeta = extractJsStringArray(src, "META_ALLOWED");
  assert.ok(pluginMeta.length > 0, "plugin.js META_ALLOWED must be non-empty");
  assert.deepEqual(
    [...pluginMeta].sort(),
    [...DEFAULT_META_ALLOWED].sort(),
    "plugin.js META_ALLOWED drifted from sp_plugin_core.DEFAULT_META_ALLOWED",
  );
});

// The two plugin.js lists must themselves be disjoint (the load-time assert mirrored).
Deno.test("WS7a: plugin.js ALLOWED and META_ALLOWED are disjoint", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  const dataSet = new Set(extractJsStringArray(src, "ALLOWED"));
  for (const v of extractJsStringArray(src, "META_ALLOWED")) {
    assert.equal(
      dataSet.has(v),
      false,
      `plugin.js: '${v}' is in BOTH allowlists`,
    );
  }
});

// Lock each allowlist to its dispatch switch arms: an allowlisted verb with no handler
// (or a handler with no allowlist entry) would pass the array-parity test but fail at
// runtime as `unknown action` → exec_failed. This closes that gap (code-review MEDIUM).
Deno.test("WS7a: plugin.js ALLOWED == dispatch() case labels (every data verb is handled)", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  assert.deepEqual(
    extractSwitchCases(src, "dispatch").sort(),
    extractJsStringArray(src, "ALLOWED").sort(),
    "plugin.js ALLOWED and dispatch() switch cases have diverged",
  );
});

Deno.test("WS7a: plugin.js META_ALLOWED == dispatchMeta() case labels (every meta verb is handled)", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  assert.deepEqual(
    extractSwitchCases(src, "dispatchMeta").sort(),
    extractJsStringArray(src, "META_ALLOWED").sort(),
    "plugin.js META_ALLOWED and dispatchMeta() switch cases have diverged",
  );
});

// Whole-file syntax gate for the hand-maintained plugin.js (code-review LOW-MEDIUM):
// build_plugin can't run `deno check` (bundler forbids dynamic-code primitives), and
// the parity tests only regex plugin.js as text — so a brace/paren typo elsewhere in
// the 700-line IIFE would ship in the canonical zip and fail only at SP import. This
// test PARSES (never executes — it would need SP's PluginAPI/window) the source; a
// SyntaxError fails the build. `new Function` is parse-only and this test file is not
// part of the bundle (manifest.yaml models: are super_productivity.ts + sp_wire.ts).
Deno.test("WS7a: plugin.js parses (whole-file syntax gate)", () => {
  const src = Deno.readTextFileSync(
    new URL("./plugin/plugin.js", import.meta.url),
  );
  // deno-lint-ignore no-new-func
  new Function(src); // throws SyntaxError on a malformed plugin.js; does not run it
});
