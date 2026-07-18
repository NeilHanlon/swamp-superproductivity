// Integration tests for the `sendCommand` I/O seam (the model half of the bridge).
//
// No live SP: a FAKE plugin runs against a temp bridge dir, verifying commands and
// writing signed responses with the real sp_wire core — so this exercises the
// genuine end-to-end round-trip (sign → atomic write → poll → verify response),
// the rate_limited retry (new id, never reused), the timeout path, and rejection
// of a forged/cross-key response. Deterministic via an injected cooperative
// `sleep` that pumps the fake plugin between polls.
//
//   ~/.swamp/deno/deno test extensions/super-productivity/super_productivity_test.ts --allow-read --allow-write

import { strict as assert } from "node:assert";
import { unzipSync } from "npm:fflate@0.8.2";
import {
  type AuthRecord,
  buildResponseEnvelope,
  type CommandPayload,
  verifyEnvelope,
} from "./sp_wire.ts";
import {
  buildPlugin,
  model,
  PLUGIN_ARCHIVE_FILES,
  sendCommand,
  type SendConfig,
  SpCommandError,
} from "./super_productivity.ts";

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
    if (!e.isFile || !e.name.endsWith(".json") || e.name.endsWith(".tmp")) {
      continue;
    }
    const cmdPath = `${cfg.commandDir}/${e.name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(await Deno.readTextFile(cmdPath));
    } catch {
      continue; // half-flushed; try next tick
    }
    const r = verifyEnvelope<CommandPayload>(auth, raw, "command", {
      nowMs: Date.now(),
    });
    await Deno.remove(cmdPath).catch(() => {});
    if (!r.ok || !r.payload) continue;
    const p = r.payload;
    seenIds.add(p.id);
    const out = handler(p.action, p.args, p.id);
    const env = out.ok
      ? buildResponseEnvelope(signAuth, {
        id: p.id,
        ts: Date.now(),
        ok: true,
        result: out.result,
      })
      : buildResponseEnvelope(signAuth, {
        id: p.id,
        ts: Date.now(),
        ok: false,
        error: out.error,
      });
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
    const handler: Handler = () => ({
      ok: false,
      error: { code: "boom", message: "no" },
    });
    await assert.rejects(
      () =>
        sendCommand(cfg, auth, "create_task", { title: "x" }, {
          sleep: async () => {
            await pumpPlugin(cfg, handler, seen);
          },
        }),
      /boom/,
    );
  });
});

Deno.test("sendCommand — signed error surfaces the structured wire code on .code (FU-2)", async () => {
  await withBridge(async (cfg) => {
    const seen = new Set<string>();
    const handler: Handler = () => ({
      ok: false,
      error: { code: "forbidden_action", action: "plugin_status" },
    });
    // The throw carries the structured code so callers branch on err.code rather
    // than substring-matching the message — while the message text is preserved.
    const err = await sendCommand(cfg, auth, "plugin_status", {}, {
      sleep: async () => {
        await pumpPlugin(cfg, handler, seen);
      },
    }).then(
      () => {
        throw new assert.AssertionError({ message: "expected a rejection" });
      },
      (e) => e,
    );
    assert.ok(err instanceof SpCommandError, "throws an SpCommandError");
    assert.equal(err.code, "forbidden_action");
    assert.equal(err.action, "plugin_status");
    assert.deepEqual(err.detail, {
      code: "forbidden_action",
      action: "plugin_status",
    });
    // Human message unchanged (nothing that logs err.message regresses).
    assert.match(err.message, /^sp action 'plugin_status' failed: /);
    assert.match(err.message, /forbidden_action/);
  });
});

Deno.test("sendCommand — SpCommandError.code is '' when the wire error carries no code (FU-2)", async () => {
  await withBridge(async (cfg) => {
    const seen = new Set<string>();
    const handler: Handler = () => ({
      ok: false,
      error: { message: "opaque" },
    });
    const err = await sendCommand(cfg, auth, "create_task", { title: "x" }, {
      sleep: async () => {
        await pumpPlugin(cfg, handler, seen);
      },
    }).then(
      () => {
        throw new assert.AssertionError({ message: "expected a rejection" });
      },
      (e) => e,
    );
    assert.ok(err instanceof SpCommandError);
    assert.equal(err.code, "");
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
    const handler: Handler = () => ({
      ok: true,
      result: "should-not-be-trusted",
    });
    await assert.rejects(
      () =>
        sendCommand(fast, auth, "get_tasks", {}, {
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
  const parsed = logTimeArgs.parse({
    taskId: "t1",
    durationMs: 1_500_000,
    date: "2026-07-16",
  });
  assert.equal(parsed.taskId, "t1");
  assert.equal(parsed.durationMs, 1_500_000);
  assert.equal(parsed.date, "2026-07-16");
  assert.equal(parsed.mode, "add"); // default applied
});

Deno.test("log_time argsSchema — date is optional; mode:'set' accepted", () => {
  const parsed = logTimeArgs.parse({
    taskId: "t1",
    durationMs: 600_000,
    mode: "set",
  });
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
  assert.equal(
    logTimeArgs.safeParse({ taskId: "", durationMs: 1000 }).success,
    false,
  );
});

Deno.test("log_time argsSchema — rejects a malformed date", () => {
  assert.equal(
    logTimeArgs.safeParse({
      taskId: "t1",
      durationMs: 1000,
      date: "07/16/2026",
    }).success,
    false,
  );
  assert.equal(
    logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date: "2026-7-6" })
      .success,
    false,
  );
});

Deno.test("log_time argsSchema — rejects calendar-invalid dates the regex alone allows", () => {
  for (
    const date of [
      "2026-06-31",
      "2026-13-01",
      "2026-00-10",
      "2026-02-30",
      "2026-11-00",
    ]
  ) {
    assert.equal(
      logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, date }).success,
      false,
      `${date} should be rejected`,
    );
  }
  // sanity: a real leap day is accepted
  assert.equal(
    logTimeArgs.safeParse({
      taskId: "t1",
      durationMs: 1000,
      date: "2024-02-29",
    }).success,
    true,
  );
});

Deno.test("log_time argsSchema — rejects a non-integer durationMs", () => {
  assert.equal(
    logTimeArgs.safeParse({ taskId: "t1", durationMs: 12.5 }).success,
    false,
  );
});

Deno.test("create_task argsSchema — accepts parentId for subtask creation", () => {
  const createArgs = model.methods.create_task.arguments;
  const parsed = createArgs.parse({ title: "child", parentId: "PARENT_ID" });
  assert.equal(parsed.parentId, "PARENT_ID");
  // parentId is optional — top-level create still works without it
  assert.equal(createArgs.safeParse({ title: "top-level" }).success, true);
});

Deno.test("log_time argsSchema — rejects an unknown mode", () => {
  assert.equal(
    logTimeArgs.safeParse({ taskId: "t1", durationMs: 1000, mode: "subtract" })
      .success,
    false,
  );
});

// ── WS7a: build_plugin (SWAMP-3 proof) + plugin_status shape ──────────────────
// The version stamp is the load-bearing invariant: the built artifact's plugin.js
// must carry manifest.json's version (not the token), and the archive must hold
// EXACTLY the fixed three files. Confirms fflate zips/unzips under the bundled Deno
// (SWAMP-13). Runs with --allow-read --allow-write.

Deno.test("build_plugin — stamps manifest version into the fixed 3-file archive", async () => {
  const pluginDir = new URL("./plugin", import.meta.url).pathname;
  const manifest = JSON.parse(
    await Deno.readTextFile(`${pluginDir}/manifest.json`),
  ) as { version: string };
  const outZip = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    const res = await buildPlugin({ pluginDir, outZip });

    // Stamped version == manifest.json (single source of truth).
    assert.equal(res.version, manifest.version);
    assert.deepEqual(
      res.files.slice().sort(),
      PLUGIN_ARCHIVE_FILES.slice().sort(),
    );
    assert.match(res.sha256, /^[0-9a-f]{64}$/);

    // The archive holds EXACTLY the fixed file list.
    const zipped = await Deno.readFile(outZip);
    assert.equal(res.bytes, zipped.length);
    const entries = unzipSync(zipped);
    assert.deepEqual(
      Object.keys(entries).sort(),
      PLUGIN_ARCHIVE_FILES.slice().sort(),
    );

    // The stamped plugin.js carries the real version and NOT the placeholder token.
    const stampedJs = new TextDecoder().decode(entries["plugin.js"]);
    assert.equal(
      stampedJs.includes("__PLUGIN_VERSION__"),
      false,
      "version token must be replaced in the artifact",
    );
    assert.ok(
      stampedJs.includes(`"${manifest.version}"`),
      "stamped version string must be present in plugin.js",
    );
  } finally {
    await Deno.remove(outZip).catch(() => {});
  }
});

Deno.test("build_plugin — fails loudly if manifest has no version", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sp-build-" });
  try {
    await Deno.writeTextFile(
      `${dir}/manifest.json`,
      JSON.stringify({ id: "x" }),
    );
    await Deno.writeTextFile(
      `${dir}/plugin.js`,
      'var PLUGIN_VERSION = "__PLUGIN_VERSION__";',
    );
    await Deno.writeTextFile(`${dir}/index.html`, "<html></html>");
    await assert.rejects(
      () => buildPlugin({ pluginDir: dir, outZip: `${dir}/out.zip` }),
      /no non-empty string 'version'/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("build_plugin — fails if plugin.js lacks the stamp token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sp-build-" });
  try {
    await Deno.writeTextFile(
      `${dir}/manifest.json`,
      JSON.stringify({ version: "9.9.9" }),
    );
    await Deno.writeTextFile(
      `${dir}/plugin.js`,
      "var PLUGIN_VERSION = 'nope';",
    );
    await Deno.writeTextFile(`${dir}/index.html`, "<html></html>");
    await assert.rejects(
      () => buildPlugin({ pluginDir: dir, outZip: `${dir}/out.zip` }),
      /missing the __PLUGIN_VERSION__ stamp token/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("build_plugin — rejects a version with characters unsafe to stamp", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sp-build-" });
  try {
    // A quote/newline in the version would break the `var PLUGIN_VERSION = "…"` literal.
    await Deno.writeTextFile(
      `${dir}/manifest.json`,
      JSON.stringify({ version: '0.1.15";evil()//' }),
    );
    await Deno.writeTextFile(
      `${dir}/plugin.js`,
      'var PLUGIN_VERSION = "__PLUGIN_VERSION__";',
    );
    await Deno.writeTextFile(`${dir}/index.html`, "<html></html>");
    await assert.rejects(
      () => buildPlugin({ pluginDir: dir, outZip: `${dir}/out.zip` }),
      /unsafe to stamp/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── FU-3: build_plugin path containment (SEC-1) ────────────────────────────────
// When a `root` is supplied, pluginDir/outZip must resolve inside it; `..` and
// out-of-root absolute paths are rejected BEFORE any fs access. In-root builds
// still succeed. Omitting `root` keeps the prior unconstrained behavior (covered
// by the tests above, which pass absolute temp paths without a root).

Deno.test("build_plugin — an in-root build still succeeds under containment", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp-contain-" });
  try {
    await Deno.writeTextFile(
      `${root}/manifest.json`,
      JSON.stringify({ version: "1.2.3" }),
    );
    await Deno.writeTextFile(
      `${root}/plugin.js`,
      'var PLUGIN_VERSION = "__PLUGIN_VERSION__";',
    );
    await Deno.writeTextFile(`${root}/index.html`, "<html></html>");
    // Relative paths resolve against the root; both stay inside it.
    const res = await buildPlugin({ pluginDir: ".", outZip: "out.zip", root });
    assert.equal(res.version, "1.2.3");
    assert.equal(res.outZip, `${root}/out.zip`);
    assert.equal((await Deno.stat(`${root}/out.zip`)).isFile, true);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("build_plugin — rejects a pluginDir that '..'-escapes the root (no fs access)", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp-contain-" });
  try {
    await assert.rejects(
      () => buildPlugin({ pluginDir: "../evil", outZip: "out.zip", root }),
      /pluginDir '\.\.\/evil' resolves to .* outside the allowed root/,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("build_plugin — rejects an out-of-root absolute outZip (no fs access)", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp-contain-" });
  try {
    await Deno.writeTextFile(
      `${root}/manifest.json`,
      JSON.stringify({ version: "1.2.3" }),
    );
    await Deno.writeTextFile(
      `${root}/plugin.js`,
      'var PLUGIN_VERSION = "__PLUGIN_VERSION__";',
    );
    await Deno.writeTextFile(`${root}/index.html`, "<html></html>");
    await assert.rejects(
      () => buildPlugin({ pluginDir: ".", outZip: "/etc/sp-evil.zip", root }),
      /outZip '\/etc\/sp-evil\.zip' resolves to .* outside the allowed root/,
    );
    // Containment triggered before any write.
    assert.equal(
      await Deno.stat("/etc/sp-evil.zip").then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("plugin_status argsSchema — takes no arguments", () => {
  assert.equal(
    model.methods.plugin_status.arguments.safeParse({}).success,
    true,
  );
});

// plugin_status.execute — the meta round-trip + the forbidden_action translation.
// Uses the same fake-bridge harness as log_time.execute (the plugin.js dispatchMeta
// handler itself is not reachable from here; this covers the MODEL side).
function statusContext(base: string) {
  const writes: Array<{ spec: string; instance: string; data: unknown }> = [];
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
    writeResource: (spec: string, instance: string, data: unknown) => {
      writes.push({ spec, instance, data });
      return Promise.resolve({ spec, instance, data });
    },
  };
  return { context, writes };
}

Deno.test("plugin_status.execute — writes a shaped pluginStatus-main from the meta reply", async () => {
  await withBridge(async (cfg) => {
    const base = cfg.commandDir.replace(/\/plugin_commands$/, "");
    const seen = new Set<string>();
    const reply = {
      version: "0.1.15",
      loopId: "abc123",
      isOwner: true,
      uptimeMs: 4200,
      scanCount: 7,
      pollMs: 1000,
      logLevel: "info",
      lock: {
        owner: "abc123",
        heartbeatAt: 1784000000000,
        ageMs: 12,
        stale: false,
      },
    };
    const handler: Handler = (action) => {
      assert.equal(action, "plugin_status");
      return { ok: true, result: reply };
    };
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        await pumpPlugin(cfg, handler, seen);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const { context, writes } = statusContext(base);
    const out = await model.methods.plugin_status.execute({}, context) as {
      dataHandles?: unknown[];
    };
    stop = true;
    await pump;

    assert.ok(
      out && Array.isArray(out.dataHandles) && out.dataHandles.length === 1,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].spec, "pluginStatus");
    assert.equal(writes[0].instance, "pluginStatus-main"); // unique data name
    const d = writes[0].data as Record<string, unknown>;
    assert.equal(d.version, "0.1.15");
    assert.equal(d.loopId, "abc123");
    assert.equal(d.isOwner, true);
    assert.equal(d.scanCount, 7);
    assert.equal((d.lock as { stale: boolean }).stale, false);
    assert.equal((d.lock as { ageMs: number }).ageMs, 12);
    assert.equal(typeof d.fetchedAt, "string");
  });
});

Deno.test("plugin_status.execute — translates forbidden_action into a rebuild/re-import hint", async () => {
  await withBridge(async (cfg) => {
    const base = cfg.commandDir.replace(/\/plugin_commands$/, "");
    const seen = new Set<string>();
    // Simulate an OLD plugin with no meta channel: the bare meta verb is forbidden.
    const handler: Handler = () => ({
      ok: false,
      error: { code: "forbidden_action", action: "plugin_status" },
    });
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        await pumpPlugin(cfg, handler, seen);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const { context, writes } = statusContext(base);
    await assert.rejects(
      () => model.methods.plugin_status.execute({}, context),
      /does not support the meta channel|re-import the plugin|Rebuild with build_plugin/,
    );
    stop = true;
    await pump;
    assert.equal(writes.length, 0); // nothing persisted on the old-plugin path
  });
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
        return {
          ok: true,
          result: { taskId: args.taskId, newMs: 1_500_000, mode: args.mode },
        };
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
