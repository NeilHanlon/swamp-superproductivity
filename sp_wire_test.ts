// Adversarial unit tests for the FROZEN sp_wire core (§3/§4).
//
// Self-contained on purpose: `node:assert` + `node:crypto` only, so it runs under
// the bundled toolchain with zero import-map setup:
//   ~/.swamp/deno/deno test extensions/models/sp_wire_test.ts --allow-read
//
// These prove the §4 properties that live IN the wire (per-message invariants):
// signature integrity, domain separation (no cross-direction reflection), key
// isolation, freshness on the signed ts, instance (`aud`) binding, id charset,
// response-binds-request, and the count/delete gating the rate-limiter relies on.
// Stateful properties (dedup-on-execute, rate-limit starvation) are the plugin
// loop's and are tested against the plugin, not here.

import { strict as assert } from "node:assert";
import {
  buildCommandEnvelope,
  buildResponseEnvelope,
  type CommandPayload,
  deriveSubkeys,
  FRESHNESS_MS,
  type ResponsePayload,
  signBytes,
  verifyEnvelope,
} from "./sp_wire.ts";

const NOW = 1_700_000_000_000; // fixed clock; freshness is deterministic
const authA = {
  v: 1,
  secret: "a".repeat(64), // 32-byte secret as hex
  instance: "11111111-1111-4111-8111-111111111111",
};
const authB = { ...authA, secret: "b".repeat(64) }; // different key, same instance
const authC = { ...authA, instance: "22222222-2222-4222-8222-222222222222" }; // same key, diff instance

function cmd(overrides: Record<string, unknown> = {}) {
  return buildCommandEnvelope(authA, {
    id: "cmd-abc123",
    ts: NOW,
    action: "get_tasks",
    args: {},
    ...overrides,
  });
}

Deno.test("happy path — command round-trips and verifies", () => {
  const env = cmd();
  const r = verifyEnvelope<CommandPayload>(authA, env, "command", {
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.payload?.action, "get_tasks");
  assert.equal(r.payload?.aud, authA.instance);
  assert.equal(r.count, true);
});

Deno.test("happy path — response round-trips with expectId binding", () => {
  const env = buildResponseEnvelope(authA, {
    id: "cmd-abc123",
    ts: NOW,
    ok: true,
    result: { tasks: [] },
  });
  const r = verifyEnvelope<ResponsePayload>(authA, env, "response", {
    nowMs: NOW,
    expectId: "cmd-abc123",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload?.result, { tasks: [] });
});

Deno.test("forged signature is rejected and NOT counted (starvation guard)", () => {
  const env = cmd();
  env.sig = "deadbeef".repeat(8); // 64 hex chars, wrong
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
  assert.equal(r.count, false); // MUST NOT count — else a token-less flooder starves us
  assert.equal(r.del, true);
});

Deno.test("tampered payload breaks the signature (verify-before-parse)", () => {
  const env = cmd();
  // Flip a byte in the opaque payload; sig no longer covers these bytes.
  env.payload = env.payload.replace("get_tasks", "delete_task");
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
  assert.equal(r.count, false);
});

Deno.test("cross-key forgery is rejected (key isolation)", () => {
  const env = cmd(); // signed with authA's secret
  const r = verifyEnvelope(authB, env, "command", { nowMs: NOW }); // verified with authB
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
});

Deno.test("cross-direction reflection is rejected (domain separation §4.3)", () => {
  // A command signed with k_cmd, replayed into the response slot (verified k_rsp).
  const commandEnv = cmd();
  const asResponse = verifyEnvelope(authA, commandEnv, "response", {
    nowMs: NOW,
  });
  assert.equal(asResponse.ok, false);
  assert.equal(asResponse.reason, "bad-signature");

  // And a response signed with k_rsp replayed into the command slot.
  const responseEnv = buildResponseEnvelope(authA, {
    id: "cmd-abc123",
    ts: NOW,
    ok: true,
    result: 1,
  });
  const asCommand = verifyEnvelope(authA, responseEnv, "command", {
    nowMs: NOW,
  });
  assert.equal(asCommand.ok, false);
  assert.equal(asCommand.reason, "bad-signature");
});

Deno.test("subkeys are domain-separated and distinct", () => {
  const { kCmd, kRsp, kEvt } = deriveSubkeys(authA.secret);
  assert.notEqual(kCmd.toString("hex"), kRsp.toString("hex"));
  assert.notEqual(kCmd.toString("hex"), kEvt.toString("hex"));
  assert.notEqual(kRsp.toString("hex"), kEvt.toString("hex"));
});

Deno.test("stale ts is rejected but COUNTED (provenance held §4.1)", () => {
  const env = cmd({ ts: NOW - FRESHNESS_MS - 1 });
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  assert.equal(r.count, true); // signed & genuine, just too old
});

Deno.test("future-dated ts beyond skew is rejected", () => {
  const env = cmd({ ts: NOW + FRESHNESS_MS + 1 });
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
});

Deno.test("ts exactly at the freshness boundary is accepted", () => {
  const env = cmd({ ts: NOW - FRESHNESS_MS });
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, true);
});

Deno.test("aud mismatch is rejected (cross-install replay §4.10)", () => {
  // Same secret (HMAC passes) but built for a different instance uuid.
  const env = buildCommandEnvelope(authC, {
    id: "cmd-abc123",
    ts: NOW,
    action: "get_tasks",
    args: {},
  });
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "aud-mismatch");
  assert.equal(r.count, true);
});

Deno.test("bad id charset is rejected, never rewritten (§4 FIX-02)", () => {
  // Craft a validly-signed payload carrying a path-traversal id.
  const { kCmd } = deriveSubkeys(authA.secret);
  const payload = JSON.stringify({
    v: 1,
    id: "../../etc/passwd",
    ts: NOW,
    aud: authA.instance,
    action: "get_tasks",
    args: {},
  });
  const env = { payload, sig: signBytes(kCmd, payload) };
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-id-charset");
});

Deno.test("response id-mismatch is rejected (response-binds-request §4.2)", () => {
  const env = buildResponseEnvelope(authA, {
    id: "some-other-id",
    ts: NOW,
    ok: true,
    result: 1,
  });
  const r = verifyEnvelope(authA, env, "response", {
    nowMs: NOW,
    expectId: "cmd-abc123",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "id-mismatch");
});

Deno.test("malformed envelopes are rejected and NOT counted", () => {
  for (
    const bad of [null, 42, "nope", {}, { payload: "x" }, { sig: "y" }, {
      payload: 1,
      sig: 2,
    }]
  ) {
    const r = verifyEnvelope(authA, bad, "command", { nowMs: NOW });
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    assert.equal(r.reason, "malformed-envelope");
    assert.equal(r.count, false);
  }
});

Deno.test("wrong protocol version is rejected", () => {
  const { kCmd } = deriveSubkeys(authA.secret);
  const payload = JSON.stringify({
    v: 2,
    id: "cmd-abc123",
    ts: NOW,
    aud: authA.instance,
    action: "get_tasks",
    args: {},
  });
  const env = { payload, sig: signBytes(kCmd, payload) };
  const r = verifyEnvelope(authA, env, "command", { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-version");
});
