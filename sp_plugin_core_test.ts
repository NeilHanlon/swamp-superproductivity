// Adversarial tests for the plugin's stateful loop (§4 items 8 & FIX-10).
//   ~/.swamp/deno/deno test extensions/models/sp_plugin_core_test.ts --allow-read
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
  const io: PluginIO = {
    now: () => nowVal,
    dispatch: (action) => {
      dispatchCalls += 1;
      return Promise.resolve({ ok: action });
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
  const v = verifyEnvelope<ResponsePayload>(auth, h.responses[0].env, "response", {
    nowMs: NOW,
    expectId: id,
  });
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
  const sum2 = await processCommands(auth, defaultConfig(), state, [replay], h.io);

  assert.equal(h.dispatchCalls, 1); // NOT executed again
  assert.deepEqual(sum2.deduped, [id]);
});

Deno.test("forged signature: rejected, not counted (starvation guard §4.8)", async () => {
  const h = harness();
  const state = newState();
  const forged = rawCmd("get_tasks", {}, { signAuth: { ...auth, secret: "9".repeat(64) } });
  const sum = await processCommands(auth, defaultConfig(), state, [forged], h.io);

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
  for (let i = 0; i < 100; i++) flood.push(rawCmd("get_tasks", {}, { signAuth: forgedAuth }));
  const legit = [rawCmd("get_tasks"), rawCmd("get_tasks"), rawCmd("get_tasks")];

  const sum = await processCommands(auth, cfg, state, [...flood, ...legit], h.io);
  assert.equal(sum.executed.length, 3); // all 3 legit ran despite 100 forged
  assert.equal(h.dispatchCalls, 3);
});

Deno.test("stale command is counted but not executed (§4.1)", async () => {
  const h = harness();
  const state = newState();
  const stale = rawCmd("get_tasks", {}, { ts: NOW - 200_000 });
  const sum = await processCommands(auth, defaultConfig(), state, [stale], h.io);

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
    const v = verifyEnvelope<ResponsePayload>(auth, resp!.env, "response", { nowMs: NOW, expectId: id });
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
  const v = verifyEnvelope<ResponsePayload>(auth, resp!.env, "response", { nowMs: NOW, expectId: id });
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
