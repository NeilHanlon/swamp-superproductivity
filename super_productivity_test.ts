// Integration tests for the `sendCommand` I/O seam (the model half of the bridge).
//
// No live SP: a FAKE plugin runs against a temp bridge dir, verifying commands and
// writing signed responses with the real sp_wire core — so this exercises the
// genuine end-to-end round-trip (sign → atomic write → poll → verify response),
// the rate_limited retry (new id, never reused), the timeout path, and rejection
// of a forged/cross-key response. Deterministic via an injected cooperative
// `sleep` that pumps the fake plugin between polls.
//
//   ~/.swamp/deno/deno test extensions/models/super_productivity_test.ts --allow-read --allow-write

import { strict as assert } from "node:assert";
import {
  type AuthRecord,
  buildResponseEnvelope,
  type CommandPayload,
  verifyEnvelope,
} from "./sp_wire.ts";
import { model, type SendConfig, sendCommand } from "./super_productivity.ts";

const auth: AuthRecord = {
  v: 1,
  secret: "f".repeat(64),
  instance: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

type Handler = (
  action: string,
  args: Record<string, unknown>,
  id: string,
) => { ok: true; result: unknown } | { ok: false; error: unknown };

// A minimal faithful plugin: verify each command with the COMMAND subkey, run the
// handler, write a signed response atomically. `signAuth` lets a test sign the
// response with a DIFFERENT record to simulate a forged/cross-key responder.
async function pumpPlugin(
  cfg: SendConfig,
  handler: Handler,
  seenIds: Set<string>,
  signAuth: AuthRecord = auth,
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(cfg.commandDir)];
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".json") || e.name.endsWith(".tmp")) continue;
    const cmdPath = `${cfg.commandDir}/${e.name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(await Deno.readTextFile(cmdPath));
    } catch {
      continue; // half-flushed; try next tick
    }
    const r = verifyEnvelope<CommandPayload>(auth, raw, "command", { nowMs: Date.now() });
    await Deno.remove(cmdPath).catch(() => {});
    if (!r.ok || !r.payload) continue;
    const p = r.payload;
    seenIds.add(p.id);
    const out = handler(p.action, p.args, p.id);
    const env = out.ok
      ? buildResponseEnvelope(signAuth, { id: p.id, ts: Date.now(), ok: true, result: out.result })
      : buildResponseEnvelope(signAuth, { id: p.id, ts: Date.now(), ok: false, error: out.error });
    const rspPath = `${cfg.responseDir}/${p.id}_response.json`;
    await Deno.writeTextFile(`${rspPath}.tmp`, JSON.stringify(env));
    await Deno.rename(`${rspPath}.tmp`, rspPath);
  }
}

async function withBridge(
  fn: (cfg: SendConfig) => Promise<void>,
): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "sp-bridge-" });
  const cfg: SendConfig = {
    commandDir: `${base}/plugin_commands`,
    responseDir: `${base}/plugin_responses`,
    timeoutMs: 30_000,
    pollIntervalMs: 5,
  };
  await Deno.mkdir(cfg.commandDir, { recursive: true });
  await Deno.mkdir(cfg.responseDir, { recursive: true });
  try {
    await fn(cfg);
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
}

Deno.test("sendCommand — happy round-trip returns the verified result", async () => {
  await withBridge(async (cfg) => {
    const seen = new Set<string>();
    const handler: Handler = (action) => {
      assert.equal(action, "get_tasks");
      return { ok: true, result: { tasks: [{ id: "t1", title: "hi" }] } };
    };
    // Cooperative pump: each poll gap advances the fake plugin one tick.
    const result = await sendCommand(cfg, auth, "get_tasks", {}, {
      sleep: async () => {
        await pumpPlugin(cfg, handler, seen);
      },
    });
    assert.deepEqual(result, { tasks: [{ id: "t1", title: "hi" }] });
    // Both files consumed.
    assert.equal([...Deno.readDirSync(cfg.commandDir)].length, 0);
    assert.equal([...Deno.readDirSync(cfg.responseDir)].length, 0);
  });
});

Deno.test("sendCommand — signed error response surfaces as a throw", async () => {
  await withBridge(async (cfg) => {
    const seen = new Set<string>();
    const handler: Handler = () => ({ ok: false, error: { code: "boom", message: "no" } });
    await assert.rejects(
      () => sendCommand(cfg, auth, "create_task", { title: "x" }, {
        sleep: async () => {
          await pumpPlugin(cfg, handler, seen);
        },
      }),
      /boom/,
    );
  });
});

Deno.test("sendCommand — rate_limited retries with a NEW id, never reused (§4.8)", async () => {
  await withBridge(async (cfg) => {
    const seen = new Set<string>();
    let calls = 0;
    const handler: Handler = () => {
      calls += 1;
      return calls === 1
        ? { ok: false, error: { code: "rate_limited" } }
        : { ok: true, result: "done" };
    };
    const result = await sendCommand(cfg, auth, "notify", { title: "t" }, {
      maxRetries: 3,
      sleep: async () => {
        await pumpPlugin(cfg, handler, seen);
      },
    });
    assert.equal(result, "done");
    assert.equal(calls, 2); // retried once
    assert.equal(seen.size, 2); // two DISTINCT ids — the retry minted a fresh id
  });
});

Deno.test("sendCommand — times out when no plugin responds", async () => {
  await withBridge(async (cfg) => {
    const fast: SendConfig = { ...cfg, timeoutMs: 40, pollIntervalMs: 5 };
    await assert.rejects(
      () => sendCommand(fast, auth, "get_tasks", {}, {}),
      /timed out/,
    );
  });
});

Deno.test("sendCommand — forged/cross-key response is ignored (seam enforces §4.3)", async () => {
  await withBridge(async (cfg) => {
    const fast: SendConfig = { ...cfg, timeoutMs: 60, pollIntervalMs: 5 };
    const seen = new Set<string>();
    // Plugin signs the response with the WRONG secret → model must ignore it.
    const wrongAuth: AuthRecord = { ...auth, secret: "0".repeat(64) };
    const handler: Handler = () => ({ ok: true, result: "should-not-be-trusted" });
    await assert.rejects(
      () => sendCommand(fast, auth, "get_tasks", {}, {
        sleep: async () => {
          await pumpPlugin(cfg, handler, seen, wrongAuth);
        },
      }),
      /timed out/,
    );
    // The forged response was consumed (deleted) during verification.
    assert.equal([...Deno.readDirSync(cfg.responseDir)].length, 0);
  });
});

// ── log_time (model side) ─────────────────────────────────────────────────────
// argsSchema shape/defaults/rejections + the execute() forwarding contract. The
// RMW clamp/sum/task-not-found logic lives PLUGIN-side (plugin.js dispatch) and is
// NOT reachable from here — see the handoff report for why it can't be unit-tested
// through this harness.

const logTimeArgs = model.methods.log_time.arguments;

Deno.test("log_time argsSchema — accepts a valid shape; mode defaults to 'add'", () => {
  const parsed = logTimeArgs.parse({ taskId: "t1", durationMs: 1_500_000, date: "2026-07-16" });
  assert.equal(parsed.taskId, "t1");
  assert.equal(parsed.durationMs, 1_500_000);
  assert.equal(parsed.date, "2026-07-16");
  assert.equal(parsed.mode, "add"); // default applied
});

Deno.test("log_time argsSchema — date is optional; mode:'set' accepted", () => {
  const parsed = logTimeArgs.parse({ taskId: "t1", durationMs: 600_000, mode: "set" });
  assert.equal(parsed.mode, "set");
  assert.equal(parsed.date, undefined);
});

Deno.test("log_time argsSchema — negative durationMs is allowed (correction delta)", () => {
  const parsed = logTimeArgs.parse({ taskId: "t1", durationMs: -1000 });
  assert.equal(parsed.durationMs, -1000);
});

Deno.test("log_time argsSchema — rejects missing taskId", () => {
  assert.equal(logTimeArgs.safeParse({ durationMs: 1000 }).success, false);
});

Deno.test("log_time argsSchema — rejects an empty taskId", () => {
  assert.equal(logTimeArgs.safeParse({ taskId: "", durationMs: 1000 }).success, false);
});

Deno.test("log_time argsSchema — rejects a malformed date", () => {
  assert.equal(logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date: "07/16/2026" }).success, false);
  assert.equal(logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date: "2026-7-6" }).success, false);
});

Deno.test("log_time argsSchema — rejects calendar-invalid dates the regex alone allows", () => {
  for (const date of ["2026-06-31", "2026-13-01", "2026-00-10", "2026-02-30", "2026-11-00"]) {
    assert.equal(
      logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date }).success,
      false,
      `${date} should be rejected`,
    );
  }
  // sanity: a real leap day is accepted
  assert.equal(logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date: "2024-02-29" }).success, true);
});

Deno.test("log_time argsSchema — rejects a non-integer durationMs", () => {
  assert.equal(logTimeArgs.safeParse({ taskId: "t1", durationMs: 12.5 }).success, false);
});

Deno.test("create_task argsSchema — accepts parentId for subtask creation", () => {
  const createArgs = model.methods.create_task.arguments;
  const parsed = createArgs.parse({ title: "child", parentId: "PARENT_ID" });
  assert.equal(parsed.parentId, "PARENT_ID");
  // parentId is optional — top-level create still works without it
  assert.equal(createArgs.safeParse({ title: "top-level" }).success, true);
});

Deno.test("log_time argsSchema — rejects an unknown mode", () => {
  assert.equal(logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, mode: "subtract" }).success, false);
});

Deno.test("log_time.execute — forwards action 'log_time' with args, then refreshes tasks", async () => {
  await withBridge(async (cfg) => {
    const base = cfg.commandDir.replace(/\/plugin_commands$/, "");
    const seen = new Set<string>();
    const cap: { args: Record<string, unknown> | null } = { args: null };
    const actions: string[] = [];
    const handler: Handler = (action, args) => {
      actions.push(action);
      if (action === "log_time") {
        cap.args = args;
        return { ok: true, result: { taskId: args.taskId, newMs: 1_500_000, mode: args.mode } };
      }
      // execute()'s snapshot refresh calls get_tasks.
      return { ok: true, result: [] };
    };
    // `call()` (used inside execute) does not accept an injected sleep, so run a
    // real background pump while execute polls for its responses.
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        await pumpPlugin(cfg, handler, seen);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const context = {
      globalArgs: {
        dataDir: base,
        authTokenPath: "",
        authSecret: auth.secret,
        authInstance: auth.instance,
        commandTimeoutS: 30,
        pollIntervalMs: 5,
        excludeTags: [],
        metadata: {},
      },
      logger: { info: () => {}, warn: () => {} },
      writeResource: (spec: string, instance: string, data: unknown) =>
        Promise.resolve({ spec, instance, data }),
    };

    const out = await model.methods.log_time.execute(
      { taskId: "abc", durationMs: 1_500_000, date: "2026-07-16", mode: "add" },
      context,
    ) as { dataHandles?: unknown[] };
    stop = true;
    await pump;

    assert.ok(cap.args, "plugin received a log_time command");
    assert.equal(cap.args!.taskId, "abc");
    assert.equal(cap.args!.durationMs, 1_500_000);
    assert.equal(cap.args!.date, "2026-07-16");
    assert.equal(cap.args!.mode, "add");
    assert.equal(actions.includes("log_time"), true);
    assert.equal(actions.includes("get_tasks"), true); // snapshot refresh happened
    assert.ok(out && Array.isArray(out.dataHandles)); // returns the refreshed tasks handle set
  });
});
