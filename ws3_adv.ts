// WS3 adversarial test harness — writes signed/forged command files directly to
// the live SP bridge dir and observes the plugin's verdicts via _debug_scan.log.
// Read-only: the only actions it ever sends are get_current_task (an allowlisted
// read). Everything else is engineered to be REJECTED before dispatch.
//
// Usage: deno run --allow-all ws3_adv.ts <case>
//   cases: forged | stale | aud | crosskey | reflect | replay | ratelimit
//
// It never deletes SP data. Rate-limit sends 35 valid reads (the only case that
// executes more than one command), by design.

import {
  buildCommandEnvelope,
  buildResponseEnvelope,
  deriveSubkeys,
  type Envelope,
  mintId,
  signBytes,
} from "./sp_wire.ts";

const BRIDGE =
  "/home/neil/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp";
const CMD_DIR = `${BRIDGE}/plugin_commands`;
const RSP_DIR = `${BRIDGE}/plugin_responses`;

const auth = JSON.parse(await Deno.readTextFile(`${BRIDGE}/.auth_token`));
// { v, secret, instance }

function nowMs() {
  return Date.now();
}

// Atomic write: .tmp then rename (mirrors the model's writer; plugin skips .tmp).
async function writeCmd(name: string, env: Envelope) {
  const tmp = `${CMD_DIR}/${name}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(env));
  await Deno.rename(tmp, `${CMD_DIR}/${name}`);
}

// A correctly-signed command envelope with the REAL secret, for the given action.
function goodEnvelope(
  action: string,
  args: Record<string, unknown> = {},
  over: Partial<{ id: string; ts: number; aud: string }> = {},
): { id: string; env: Envelope } {
  const id = over.id ?? mintId();
  const ts = over.ts ?? nowMs();
  const record = over.aud ? { ...auth, instance: over.aud } : auth;
  const env = buildCommandEnvelope(record, { id, ts, action, args });
  return { id, env };
}

const kase = Deno.args[0];
const stamp = `${nowMs()}`;

switch (kase) {
  // ── a. Forged signature: valid payload, WRONG secret ──────────────────────
  case "forged": {
    const wrong = { ...auth, secret: "00".repeat(32) };
    const id = mintId();
    const env = buildCommandEnvelope(wrong, {
      id,
      ts: nowMs(),
      action: "get_current_task",
      args: {},
    });
    const name = `adv_forged_${stamp}.json`;
    await writeCmd(name, env);
    console.log(
      JSON.stringify({
        kase,
        name,
        id,
        expect: "bad-signature (delete, not counted, no response)",
      }),
    );
    break;
  }

  // ── c. Stale timestamp: correctly signed, ts = now − 300s ─────────────────
  case "stale": {
    const { id, env } = goodEnvelope("get_current_task", {}, {
      ts: nowMs() - 300_000,
    });
    const name = `adv_stale_${stamp}.json`;
    await writeCmd(name, env);
    console.log(
      JSON.stringify({
        kase,
        name,
        id,
        expect: "stale (counted, deleted, no response)",
      }),
    );
    break;
  }

  // ── e. aud mismatch: real secret, wrong instance uuid ─────────────────────
  case "aud": {
    const { id, env } = goodEnvelope("get_current_task", {}, {
      aud: "00000000-dead-beef-0000-000000000000",
    });
    const name = `adv_aud_${stamp}.json`;
    await writeCmd(name, env);
    console.log(
      JSON.stringify({
        kase,
        name,
        id,
        expect: "aud-mismatch (counted, deleted, no response)",
      }),
    );
    break;
  }

  // ── g. Cross-key: command payload signed with k_rsp instead of k_cmd ──────
  case "crosskey": {
    const { kRsp } = deriveSubkeys(auth.secret);
    const id = mintId();
    const payloadObj = {
      v: 1,
      id,
      ts: nowMs(),
      aud: auth.instance,
      action: "get_current_task",
      args: {},
    };
    const payload = JSON.stringify(payloadObj);
    const env: Envelope = { payload, sig: signBytes(kRsp, payload) };
    const name = `adv_crosskey_${stamp}.json`;
    await writeCmd(name, env);
    console.log(
      JSON.stringify({
        kase,
        name,
        id,
        expect: "bad-signature (wrong subkey for command direction)",
      }),
    );
    break;
  }

  // ── d. Reflection: k_cmd-signed 'response' dropped into plugin_responses/ ──
  //   The plugin never reads plugin_responses/ (it only writes there). The
  //   MODEL reads responses and verifies with k_rsp; a k_cmd-signed blob must
  //   fail its verify. This case just plants the artifact + verifies model-side
  //   rejection logically (the model's sendCommand only accepts k_rsp + matching
  //   id). We assert the plugin does NOT consume it (wrong dir) and that a
  //   k_cmd sig != a k_rsp sig over the same bytes.
  case "reflect": {
    const { kCmd, kRsp } = deriveSubkeys(auth.secret);
    const id = mintId();
    const payloadObj = {
      v: 1,
      id,
      ts: nowMs(),
      aud: auth.instance,
      ok: true,
      result: { spoofed: true },
    };
    const payload = JSON.stringify(payloadObj);
    const cmdSig = signBytes(kCmd, payload);
    const rspSig = signBytes(kRsp, payload);
    const env: Envelope = { payload, sig: cmdSig };
    const name = `${id}_response.json`;
    await Deno.writeTextFile(`${RSP_DIR}/${name}.tmp`, JSON.stringify(env));
    await Deno.rename(`${RSP_DIR}/${name}.tmp`, `${RSP_DIR}/${name}`);
    console.log(JSON.stringify({
      kase,
      name,
      id,
      cmdSig_ne_rspSig: cmdSig !== rspSig,
      expect:
        "model rejects: k_cmd sig != k_rsp sig; plugin never reads responses/",
    }));
    break;
  }

  // ── b. Replay: send valid read, then re-drop the SAME id ──────────────────
  case "replay": {
    const { id, env } = goodEnvelope("get_current_task");
    const n1 = `adv_replay_${stamp}_a.json`;
    await writeCmd(n1, env);
    console.log(
      JSON.stringify({
        kase: "replay-1",
        name: n1,
        id,
        expect: "executes once, writes response",
      }),
    );
    // Wait for the plugin to execute + respond, then replay the exact same envelope.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await Deno.stat(`${RSP_DIR}/${id}_response.json`);
        break;
      } catch { /* not yet */ }
    }
    const n2 = `adv_replay_${stamp}_b.json`;
    await writeCmd(n2, env);
    console.log(
      JSON.stringify({
        kase: "replay-2",
        name: n2,
        id,
        expect: "deduped (skip execute, delete)",
      }),
    );
    break;
  }

  // ── f. Rate-limit: 35 valid reads; 30 execute, 5 signed rate_limited ──────
  case "ratelimit": {
    const ids: string[] = [];
    for (let i = 0; i < 35; i++) {
      const { id, env } = goodEnvelope("get_current_task");
      ids.push(id);
      await writeCmd(`adv_rl_${stamp}_${String(i).padStart(2, "0")}.json`, env);
    }
    console.log(
      JSON.stringify({
        kase,
        count: ids.length,
        firstId: ids[0],
        lastId: ids[34],
        expect: "30 executed, 5 rate_limited responses",
      }),
    );
    break;
  }

  default:
    console.error("unknown case:", kase);
    Deno.exit(2);
}
