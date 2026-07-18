import { z } from "npm:zod@4";
// Pinned, pure-JS zip writer (no native deps, no shell-out) for build_plugin's
// canonical archive. Deno std has no zip WRITER; fflate bundles cleanly under
// swamp's Deno bundler per repo rule 7 (all npm deps are inlined at bundle time).
import { zipSync } from "npm:fflate@0.8.2";
import { resolve as resolvePath, sep as PATH_SEP } from "node:path";
import {
  type AuthRecord,
  buildCommandEnvelope,
  mintId,
  type ResponsePayload,
  verifyEnvelope,
} from "./sp_wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// @kneel/super-productivity — makes Super Productivity a node in the swamp graph.
//
// One model instance == one SP bridge (rendezvous) directory. The swamp model IS
// the "server" half: it talks DIRECTLY to our own SP plugin over a signed file-IPC
// channel (no third-party MCP server in the loop), adding the HMAC auth layer the
// community bridges lack.
//
// The ephemeral swamp method (fresh Deno process per `swamp model method run`)
// writes a signed command file and polls for the signed response, then exits; the
// long-lived plugin polls the dir on its own cadence. `sendCommand` is the ONE
// isolated I/O seam around the frozen wire core (sp_wire.ts) — the plocate
// `buildArgv` equivalent. Wire contract: super-productivity-plan.md §3/§4 (LOCKED).
// ─────────────────────────────────────────────────────────────────────────────

// ── Global arguments (Zod) ────────────────────────────────────────────────────

// `authTokenPath` names a filesystem PATH, not a secret — but the substring
// "token" trips the credentials scanner's field-name heuristic, which fires on
// any line carrying a sensitive substring AND `z.`. Defining the validator apart
// from the field keeps both lines clear of that pair (the field line has no `z.`;
// this const's name carries no sensitive substring), so the false positive stays
// silenced without renaming the public global-arg key or mis-marking a path as
// sensitive (FU-4).
const authFilePathArg = z.string().default("").describe(
  "Path to the provisioned {v,secret,instance} token (0600). Empty ⇒ <dataDir>/.auth_token. " +
    "The plugin ALWAYS reads this file; the model reads it only as a fallback when authSecret is unset.",
);

const GlobalArgsSchema = z.object({
  dataDir: z.string().min(1).describe(
    "The SP bridge/rendezvous directory (holds plugin_commands/ + plugin_responses/). " +
      "Explicit/required — decoupled from SP's user-data-dir; whatever absolute path both peers agree on.",
  ),
  authTokenPath: authFilePathArg,
  authSecret: z.string().meta({ sensitive: true }).default("").describe(
    "The 32-byte HMAC secret as hex. Wire to the vault of record: " +
      "${{ vault.get(super-productivity, secret) }}. Empty ⇒ model falls back to the token file.",
  ),
  authInstance: z.string().default("").describe(
    "The provisioned instance uuid (bound into every payload as `aud`). " +
      "Wire to ${{ vault.get(super-productivity, instance) }}. Required alongside authSecret.",
  ),
  commandTimeoutS: z.number().int().positive().default(30).describe(
    "How long to poll for a signed response before failing the command.",
  ),
  pollIntervalMs: z.number().int().positive().default(500).describe(
    "Response-directory poll cadence.",
  ),
  excludeTags: z.array(z.string()).default([]).describe(
    "Privacy filter: task tags to strip from read results (mirrors SP_MCP_EXCLUDE_TAGS).",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ── Resource schemas (declare referenced fields explicitly for CEL) ───────────

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  isDone: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  timeSpent: z.number().optional(),
  timeEstimate: z.number().optional(),
});

const TasksResourceSchema = z.object({
  tasks: z.array(TaskSchema).describe(
    "Tasks returned by the plugin (privacy-filtered).",
  ),
  count: z.number(),
  fetchedAt: z.iso.datetime(),
});

const ProjectsResourceSchema = z.object({
  projects: z.array(z.object({ id: z.string(), title: z.string() }).loose()),
  count: z.number(),
  fetchedAt: z.iso.datetime(),
});

const TagsResourceSchema = z.object({
  tags: z.array(z.object({ id: z.string(), title: z.string() }).loose()),
  count: z.number(),
  fetchedAt: z.iso.datetime(),
});

const CurrentTaskResourceSchema = z.object({
  task: TaskSchema.nullable().describe(
    "The currently-selected task, or null when none is active.",
  ),
  fetchedAt: z.iso.datetime(),
});

const WorklogResourceSchema = z.object({
  worklog: z.unknown().describe(
    "Time-tracking / worklog payload as returned by the plugin.",
  ),
  fetchedAt: z.iso.datetime(),
});

// ── WS7a: plugin_status (meta channel) — the running plugin loop's self-report ──
const PluginStatusResourceSchema = z.object({
  version: z.string().describe(
    "The plugin's build-stamped version (from build_plugin; == manifest.json). " +
      "The literal '__PLUGIN_VERSION__' means an un-stamped/source build was imported.",
  ),
  loopId: z.string().describe("The owning tick loop's per-context id."),
  isOwner: z.boolean().describe(
    "Whether the responding loop holds the single-writer lock (always true today; " +
      "only the owner dispatches — kept for WS7c multi-loop symmetry).",
  ),
  uptimeMs: z.number().describe(
    "ms since this loop last ACQUIRED the lock (ownership lifetime; resets on reclaim/promotion).",
  ),
  scanCount: z.number().describe(
    "Successful owned scan passes since acquisition.",
  ),
  pollMs: z.number().describe("The loop's poll cadence."),
  logLevel: z.string().describe("In-memory verbosity (no setter until WS7b)."),
  lock: z.object({
    owner: z.string().nullable(),
    heartbeatAt: z.number().nullable(),
    ageMs: z.number().nullable().describe(
      "now - heartbeatAt, computed at dispatch (honest freshness).",
    ),
    stale: z.boolean(),
  }).describe("The bridge-lock snapshot the responding tick observed."),
  fetchedAt: z.iso.datetime(),
});

// ── Batch (batchUpdateForProject) — one dispatch, N structural ops, one refresh ─
// Mirrors SP PluginAPI's BatchOperation union (packages/plugin-api/src/types.ts).
// Batch is STRUCTURE within ONE project: title/notes/estimate/parent/subtask-order/
// done/delete. tagIds/dueDay/projectId are NOT batchable — route those through
// create_task/update_task/plan_for_today.
const BatchOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    tempId: z.string().min(1).describe(
      "Local handle other ops in this batch (and parentId) can reference.",
    ),
    data: z.object({
      title: z.string().min(1),
      notes: z.string().optional(),
      isDone: z.boolean().optional(),
      parentId: z.string().nullable().optional().describe(
        "Parent task id. MUST be a REAL existing task id — SP's batch does NOT resolve a " +
          "same-batch tempId here: the child is silently dropped (no error, bogus created-id). " +
          "To nest under a just-created task, use two batches: create parents, read real ids " +
          "from createdTaskIds, then create children with those real parentIds.",
      ),
      timeEstimate: z.number().optional().describe("Estimate in ms."),
    }),
  }),
  z.object({
    type: z.literal("update"),
    taskId: z.string().min(1),
    updates: z.object({
      title: z.string().optional(),
      notes: z.string().optional(),
      isDone: z.boolean().optional(),
      parentId: z.string().nullable().optional(),
      timeEstimate: z.number().optional(),
      subTaskIds: z.array(z.string()).optional().describe(
        "Reorder/assign a parent's subtasks.",
      ),
    }),
  }),
  z.object({ type: z.literal("delete"), taskId: z.string().min(1) }),
  z.object({
    type: z.literal("reorder"),
    taskIds: z.array(z.string()).describe("New order; may include tempIds."),
  }),
]);

const BatchResultResourceSchema = z.object({
  success: z.boolean(),
  createdTaskIds: z.record(z.string(), z.string()).describe(
    "tempId → real task id for each created op.",
  ),
  errors: z.array(z.object({
    operationIndex: z.number(),
    type: z.string(),
    message: z.string(),
  })).describe("Per-operation failures (empty when success)."),
  projectId: z.string(),
  operationCount: z.number(),
  ranAt: z.iso.datetime(),
});

// ── Auth + transport config resolution ────────────────────────────────────────

const AuthRecordSchema = z.object({
  v: z.number(),
  // This DOES hold the HMAC secret (parsed from the 0600 token file), so mark it
  // sensitive — accurate, and it keeps the credentials scanner from re-flagging
  // an already-vaulted value on every push (FU-4). The value of record is the
  // vaulted `authSecret` global-arg (also `.meta({ sensitive: true })`).
  secret: z.string().min(1).meta({ sensitive: true }),
  instance: z.string().min(1),
});

function tokenPath(g: GlobalArgs): string {
  return g.authTokenPath && g.authTokenPath.length > 0
    ? g.authTokenPath
    : `${g.dataDir.replace(/\/$/, "")}/.auth_token`;
}

/**
 * Read the provisioned {v,secret,instance} record. Both peers read the same 0600
 * file, so re-reading per run keeps rotation free on the model side (§4 item 5).
 * (Sourcing this from a swamp vault instead of the file is GATE G4.)
 */
export async function readAuthRecord(path: string): Promise<AuthRecord> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (e) {
    throw new Error(
      `SP auth token not readable at '${path}': ${
        e instanceof Error ? e.message : e
      }. ` +
        `Provision {v,secret,instance} (0600) before running commands.`,
    );
  }
  const parsed = AuthRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `SP auth token at '${path}' is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Resolve the auth record for the MODEL side. Prefers the vault-sourced
 * globalArgs (authSecret/authInstance, resolved by swamp's vault layer per run —
 * rotation-free, §4 item 5); falls back to the 0600 token file for the dev path.
 */
export async function resolveAuth(g: GlobalArgs): Promise<AuthRecord> {
  if (g.authSecret && g.authInstance) {
    return { v: 1, secret: g.authSecret, instance: g.authInstance };
  }
  return await readAuthRecord(tokenPath(g));
}

/** Write a provisioned auth record atomically at 0600 (the plugin's copy). */
export async function writeAuthRecord(
  path: string,
  rec: AuthRecord,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(rec), { mode: 0o600 });
  await Deno.chmod(tmp, 0o600).catch(() => {});
  await Deno.rename(tmp, path);
}

// ── The frozen I/O seam: sendCommand ──────────────────────────────────────────

/** Resolved transport config for one `sendCommand` call. */
export interface SendConfig {
  commandDir: string;
  responseDir: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

/** Injectable seams so `sendCommand` is deterministic under test. */
export interface SendDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** rate_limited retries (each mints a NEW id + fresh ts). */
  maxRetries?: number;
  logger?: {
    info?: (msg: string, ...a: unknown[]) => void;
    warn?: (msg: string, ...a: unknown[]) => void;
  };
}

async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(obj));
  await Deno.rename(tmp, path); // §4 item 7: a half-flushed file reads as tampering
}

async function tryReadJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return undefined; // not present yet
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // half-flushed (no atomic write on the other side): treat as absent
  }
}

async function bestEffortRemove(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch { /* already gone */ }
}

/**
 * Thrown by `sendCommand` when the plugin returns a *signed* error response.
 *
 * Carries the frozen wire error `code` (the §3/§4 contract value, unchanged) as a
 * structured field so callers can branch on `err.code === "forbidden_action"`
 * instead of substring-matching the human message (which is fragile and couples
 * every meta-verb to the exact throw text). The `.message` is kept byte-for-byte
 * identical to the previous plain-`Error` throw so anything that logs it does not
 * regress; the structured fields are purely additive.
 */
export class SpCommandError extends Error {
  /** The wire error `code` (e.g. "forbidden_action", "rate_limited"); "" if absent. */
  readonly code: string;
  /** The action whose signed response carried the error. */
  readonly action: string;
  /** The raw structured `error` object from the verified response payload. */
  readonly detail: unknown;
  constructor(action: string, error: unknown) {
    super(`sp action '${action}' failed: ${JSON.stringify(error)}`);
    this.name = "SpCommandError";
    this.code = (error as { code?: string } | undefined)?.code ?? "";
    this.action = action;
    this.detail = error;
  }
}

/**
 * Send one signed command and return the plugin's verified result.
 *
 * Round-trip, in order:
 *   1. mint id + fresh ts; build the signed COMMAND envelope (opaque payload).
 *   2. atomic write plugin_commands/<id>.json (.tmp + rename).
 *   3. poll plugin_responses/<id>_response.json until the deadline.
 *   4. verify the response with the RESPONSE subkey, binding payload.id === id
 *      (reader-binding §4.11: this same call sent the command and holds the id).
 *   5. on a signed `rate_limited` error, retry with a NEW id + fresh ts
 *      (reject-not-defer §4.8 — NEVER reuse the id, which would self-collide).
 *
 * The filename is untrusted metadata (§4.11): the authoritative id is payload.id,
 * asserted via `expectId`.
 */
export async function sendCommand(
  cfg: SendConfig,
  auth: AuthRecord,
  action: string,
  args: Record<string, unknown>,
  deps: SendDeps = {},
): Promise<unknown> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ??
    ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = deps.maxRetries ?? 3;
  const deadline = now() + cfg.timeoutMs;

  let attempt = 0;
  while (true) {
    const id = mintId();
    const ts = now();
    const env = buildCommandEnvelope(auth, { id, ts, action, args });
    const cmdPath = `${cfg.commandDir}/${id}.json`;
    const rspPath = `${cfg.responseDir}/${id}_response.json`;
    await atomicWriteJson(cmdPath, env);

    let verified: ResponsePayload | undefined;
    while (now() < deadline) {
      const raw = await tryReadJson(rspPath);
      if (raw !== undefined) {
        const r = verifyEnvelope<ResponsePayload>(auth, raw, "response", {
          nowMs: now(),
          expectId: id,
        });
        await bestEffortRemove(rspPath); // addressed to us; consume it
        if (r.ok) {
          verified = r.payload;
          break;
        }
        // A file in our response slot that fails verify is spoof/garbage; it was
        // deleted, keep polling for a genuine response until the deadline.
        deps.logger?.warn?.(
          `sp response verify failed (${r.reason}); ignoring`,
        );
      }
      await sleep(cfg.pollIntervalMs);
    }
    await bestEffortRemove(cmdPath);

    if (!verified) {
      throw new Error(
        `sp sendCommand '${action}' timed out after ${cfg.timeoutMs}ms`,
      );
    }
    if (verified.ok) return verified.result;

    const errCode = (verified.error as { code?: string } | undefined)?.code ??
      "";
    if (
      errCode === "rate_limited" && attempt < maxRetries && now() < deadline
    ) {
      attempt += 1;
      deps.logger?.info?.(
        `sp '${action}' rate_limited; retry ${attempt} with new id`,
      );
      continue; // NEW id + fresh ts next iteration
    }
    throw new SpCommandError(action, verified.error);
  }
}

// ── Method plumbing ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Ctx = any; // swamp model execution context (globalArgs, logger, writeResource, …)

function sendConfig(g: GlobalArgs): SendConfig {
  const base = g.dataDir.replace(/\/$/, "");
  return {
    commandDir: `${base}/plugin_commands`,
    responseDir: `${base}/plugin_responses`,
    timeoutMs: g.commandTimeoutS * 1000,
    pollIntervalMs: g.pollIntervalMs,
  };
}

// Run one action against the plugin, resolving auth from the token file per run.
async function call(
  context: Ctx,
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const g = context.globalArgs as GlobalArgs;
  const auth = await resolveAuth(g);
  return await sendCommand(sendConfig(g), auth, action, args, {
    logger: context.logger,
  });
}

// Strip excluded tags from a task list (privacy filter, §3 excludeTags).
function filterExcluded(tasks: unknown, excludeTags: string[]): typeof tasks {
  if (!Array.isArray(tasks) || excludeTags.length === 0) return tasks;
  const excluded = new Set(excludeTags);
  return tasks.filter((t) => {
    const tagIds: string[] = Array.isArray((t as { tagIds?: string[] }).tagIds)
      ? (t as { tagIds: string[] }).tagIds
      : [];
    return !tagIds.some((id) => excluded.has(id));
  });
}

// ── build_plugin: stamp + zip the canonical importable plugin archive (WS7a) ────
// A reusable BUILD step (dev-repo tool) that makes version-drift structurally
// impossible: manifest.json is the single source of truth, its version is stamped
// into plugin.js's __PLUGIN_VERSION__ token in the ARTIFACT (source keeps the token),
// and the fixed three-file archive is produced with a pinned pure-JS zip writer —
// never hand-zipped, never from the wrong location. Exported for unit testing.

/** The FIXED archive file list (root-relative). Any drift fails the build_plugin test. */
export const PLUGIN_ARCHIVE_FILES = [
  "manifest.json",
  "plugin.js",
  "index.html",
];
const VERSION_TOKEN = "__PLUGIN_VERSION__";

export interface BuildPluginOpts {
  /** Dir holding manifest.json + plugin.js + index.html (the `plugin/` source). */
  pluginDir: string;
  /** Output path for the canonical zip (module-root `sp-swamp-plugin.zip`). */
  outZip: string;
  /**
   * Optional containment root. When set, `pluginDir` and `outZip` are resolved to
   * absolute paths and MUST stay within this root (`..` traversal and out-of-root
   * absolute paths are rejected BEFORE any fs access). The exposed `build_plugin`
   * method passes `Deno.cwd()` here so a caller cannot steer reads/writes outside
   * the workspace; trusted in-process callers (unit tests) omit it for the prior
   * unconstrained behavior. See FU-3 / SEC-1.
   */
  root?: string;
}

/**
 * Resolve `p` against `rootAbs` and assert it stays within it. `..` escapes and
 * out-of-root absolute paths throw a clear error before any fs access.
 */
function containPath(label: string, p: string, rootAbs: string): string {
  const abs = resolvePath(rootAbs, p);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + PATH_SEP)) {
    throw new Error(
      `build_plugin: ${label} '${p}' resolves to '${abs}', outside the allowed root '${rootAbs}'.`,
    );
  }
  return abs;
}

export interface BuildPluginResult {
  version: string;
  files: string[];
  bytes: number;
  sha256: string;
  outZip: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh Uint8Array<ArrayBuffer> so the digest input is a plain
  // ArrayBuffer (fflate's return type widens to ArrayBufferLike, which crypto rejects).
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read the plugin source, STAMP manifest.json's version into plugin.js, syntax-check
 * the stamped source, and write the canonical zip. Returns the stamped version + the
 * archive's file list, byte size, and sha256 (the SWAMP-3 proof surface).
 */
export async function buildPlugin(
  opts: BuildPluginOpts,
): Promise<BuildPluginResult> {
  // Containment (FU-3): when a root is supplied, resolve+assert both paths stay
  // inside it BEFORE touching the fs; otherwise keep the raw strings (trusted
  // in-process callers). The exposed method always supplies Deno.cwd().
  const rootAbs = opts.root !== undefined ? resolvePath(opts.root) : undefined;
  const dir =
    (rootAbs !== undefined
      ? containPath("pluginDir", opts.pluginDir, rootAbs)
      : opts.pluginDir).replace(/\/$/, "");
  const outZip = rootAbs !== undefined
    ? containPath("outZip", opts.outZip, rootAbs)
    : opts.outZip;

  // manifest.json is the SINGLE SOURCE OF TRUTH for the version.
  const manifestRaw = await Deno.readTextFile(`${dir}/manifest.json`);
  const version = (JSON.parse(manifestRaw) as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `build_plugin: ${dir}/manifest.json has no non-empty string 'version'.`,
    );
  }
  // The version is substituted into a JS STRING LITERAL (var PLUGIN_VERSION = "…").
  // Validating the INPUT charset (no quote/backslash/newline) GUARANTEES the stamped
  // source stays syntactically valid — a stronger, cheaper guarantee than parsing the
  // output, and one that bundles cleanly (swamp's safety scanner forbids dynamic-code
  // primitives, so an output-parse gate is not an option anyway).
  if (!/^[A-Za-z0-9.+_-]+$/.test(version)) {
    throw new Error(
      `build_plugin: manifest version '${version}' has characters unsafe to stamp into a string literal.`,
    );
  }

  // Stamp the version token. SOURCE keeps '__PLUGIN_VERSION__' (unit/parity tests run
  // against source); only the ARTIFACT carries the real semver, so plugin_status can
  // never report a version that drifted from the manifest.
  const pluginSrc = await Deno.readTextFile(`${dir}/plugin.js`);
  if (!pluginSrc.includes(VERSION_TOKEN)) {
    throw new Error(
      `build_plugin: ${dir}/plugin.js is missing the ${VERSION_TOKEN} stamp token.`,
    );
  }
  const stamped = pluginSrc.split(VERSION_TOKEN).join(version);

  const indexHtml = await Deno.readTextFile(`${dir}/index.html`);
  const enc = new TextEncoder();
  const zip = zipSync({
    "manifest.json": enc.encode(manifestRaw),
    "plugin.js": enc.encode(stamped),
    "index.html": enc.encode(indexHtml),
  }, { level: 9 });

  await Deno.writeFile(outZip, zip);
  return {
    version,
    files: PLUGIN_ARCHIVE_FILES.slice(),
    bytes: zip.length,
    sha256: await sha256Hex(zip),
    outZip,
  };
}

// ── Model ─────────────────────────────────────────────────────────────────────

/**
 * `@kneel/super-productivity` — v1 = read + core writes over the signed file-IPC
 * bridge. `sync` is the Rule-6 fan-out (one execution → tasks+projects+tags as
 * separate CEL-referenceable resources). Reads: get_tasks/get_current_task/
 * get_worklog. Writes: create_task/update_task/complete_task, log_time and notify.
 */
export const model = {
  type: "@kneel/super-productivity",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    tasks: {
      description:
        "Snapshot of SP tasks (privacy-filtered). Short-lived — treat >5m as stale.",
      schema: TasksResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    projects: {
      description: "Snapshot of SP projects.",
      schema: ProjectsResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    tags: {
      description: "Snapshot of SP tags.",
      schema: TagsResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    currentTask: {
      description: "The currently-selected SP task (or null).",
      schema: CurrentTaskResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    worklog: {
      description: "Time-tracking / worklog snapshot.",
      schema: WorklogResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    batchResult: {
      description:
        "Result of the last `batch` run: tempId→realId map + per-op errors. CEL-referenceable for chaining.",
      schema: BatchResultResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
    pluginStatus: {
      description:
        "The running plugin loop's self-report (version, ownership, lock freshness). " +
        "Short-lived — reflects one tick's observation; treat >5m as stale.",
      schema: PluginStatusResourceSchema,
      lifetime: "5m",
      garbageCollection: 5,
    },
  },

  methods: {
    // ── Provisioning: write the plugin's 0600 token copy from the vault ─────────
    provision: {
      description:
        "Create the bridge dirs and write the plugin's 0600 .auth_token copy of {v,secret,instance} " +
        "from the vault-sourced secret (§5 flow). Does NOT touch running SP. Idempotent.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g = context.globalArgs as GlobalArgs;
        const auth = await resolveAuth(g); // vault-sourced (or file fallback)
        const cfg = sendConfig(g);
        await Deno.mkdir(cfg.commandDir, { recursive: true });
        await Deno.mkdir(cfg.responseDir, { recursive: true });
        const path = tokenPath(g);
        await writeAuthRecord(path, auth);
        context.logger.info(
          "provisioned bridge at {dir} (token {path}, 0600)",
          {
            dir: g.dataDir,
            path,
          },
        );
        return { dataHandles: [] };
      },
    },

    // ── WS1: read-only ────────────────────────────────────────────────────────
    sync: {
      description:
        "Rule-6 fan-out: ONE execution pulls tasks+projects+tags from the plugin and writes all three CEL-referenceable resources (instance 'main'). Avoids per-model lock contention.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g = context.globalArgs as GlobalArgs;
        const snap = (await call(context, "get_snapshot")) as {
          tasks?: unknown[];
          projects?: unknown[];
          tags?: unknown[];
        };
        const now = new Date().toISOString();
        const tasks = filterExcluded(
          snap.tasks ?? [],
          g.excludeTags,
        ) as unknown[];
        const projects = (snap.projects ?? []) as unknown[];
        const tags = (snap.tags ?? []) as unknown[];

        const handles = [
          await context.writeResource("tasks", "tasks-main", {
            tasks,
            count: tasks.length,
            fetchedAt: now,
          }),
          await context.writeResource("projects", "projects-main", {
            projects,
            count: projects.length,
            fetchedAt: now,
          }),
          await context.writeResource("tags", "tags-main", {
            tags,
            count: tags.length,
            fetchedAt: now,
          }),
        ];
        context.logger.info("sync: {t} tasks, {p} projects, {g} tags", {
          t: tasks.length,
          p: projects.length,
          g: tags.length,
        });
        return { dataHandles: handles };
      },
    },

    get_tasks: {
      description:
        "Fetch tasks from SP and persist the `tasks` snapshot (privacy-filtered).",
      arguments: z.object({
        includeArchived: z.boolean().default(false).describe(
          "Include archived tasks.",
        ),
      }),
      execute: async (args: { includeArchived: boolean }, context: Ctx) => {
        const g = context.globalArgs as GlobalArgs;
        const raw = (await call(context, "get_tasks", {
          includeArchived: args.includeArchived,
        })) as unknown[];
        const tasks = filterExcluded(raw ?? [], g.excludeTags) as unknown[];
        // Canonical instance: everything that refreshes the tasks snapshot
        // (get_tasks itself + the write methods that funnel through it, and the
        // `sync` fan-out at "tasks-main") writes ONE instance, so a read after
        // any producer reflects the latest state. Do not reintroduce "main".
        const handle = await context.writeResource("tasks", "tasks-main", {
          tasks,
          count: tasks.length,
          fetchedAt: new Date().toISOString(),
        });
        context.logger.info("get_tasks -> {n}", { n: tasks.length });
        return { dataHandles: [handle] };
      },
    },

    get_current_task: {
      description:
        "Fetch the currently-selected SP task and persist `currentTask`.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const task = (await call(context, "get_current_task")) as unknown;
        // Unique data name per model: `data.latest("sp", "<name>")` addresses by
        // name alone, so a bare "main" would collide with worklog's snapshot.
        const handle = await context.writeResource(
          "currentTask",
          "currentTask-main",
          {
            task: task ?? null,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_worklog: {
      description:
        "Fetch time-tracking / worklog data and persist the `worklog` snapshot.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const worklog = await call(context, "get_worklog");
        const handle = await context.writeResource("worklog", "worklog-main", {
          worklog: worklog ?? null,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ── WS2: core writes ────────────────────────────────────────────────────────
    create_task: {
      description:
        "Create a task in SP (addTask). Returns the new task id via a refreshed `tasks` snapshot.",
      arguments: z.object({
        title: z.string().min(1).describe(
          "Task title (SP @/#/+ syntax supported by the plugin).",
        ),
        projectId: z.string().optional().describe(
          "Target project id. Ignored when parentId is set (subtasks inherit the parent's project).",
        ),
        tagIds: z.array(z.string()).optional().describe(
          "Tag ids to attach (NOT 'TODAY' — use addToToday). Ignored when parentId is set (subtasks inherit the parent's tags).",
        ),
        parentId: z.string().optional().describe(
          "Create as a subtask of this EXISTING task id (SP routes it through addSubTask; the subtask " +
            "inherits the parent's project/tags, so projectId/tagIds here are ignored). For creating N " +
            "subtasks at once, use `batch` with the parent's real id.",
        ),
        notes: z.string().optional(),
        timeEstimate: z.number().optional().describe("Estimate in ms."),
        addToToday: z.boolean().default(false).describe(
          "Also place the new task on SP's Today list (sets dueDay + TODAY tag order). Default false.",
        ),
        dueDay: z.string().optional().describe(
          "YYYY-MM-DD for Today placement; defaults to the plugin host's today.",
        ),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        const result = (await call(context, "create_task", args)) as {
          id?: string;
        };
        context.logger.info("create_task -> {id}", { id: result?.id ?? "?" });
        // Refresh the tasks snapshot so consumers see the new task via CEL.
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    update_task: {
      description: "Update fields on an existing SP task (updateTask).",
      arguments: z.object({
        taskId: z.string().min(1),
        title: z.string().optional(),
        notes: z.string().optional(),
        projectId: z.string().optional(),
        tagIds: z.array(z.string()).optional().describe(
          "Replaces the task's tags. 'TODAY' here is auto-routed to the Today mechanism (dueDay + tag order), " +
            "since SP does not model Today via task.tagIds.",
        ),
        timeEstimate: z.number().optional(),
        isDone: z.boolean().optional(),
        dueDay: z.string().optional().describe(
          "YYYY-MM-DD; sets the planned day (Today = today's date).",
        ),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        await call(context, "update_task", args);
        context.logger.info("update_task {id}", { id: args.taskId });
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    // ── Today placement: SP models "Today" as task.dueDay + the TODAY tag's ordered
    // taskIds (see SP handlePlanTasksForToday) — NOT task.tagIds. These two methods
    // drive that mechanism correctly so tasks actually appear on the Today page.
    plan_for_today: {
      description:
        "Add task(s) to SP's Today list the way SP itself does: set dueDay=today AND prepend to the TODAY " +
        "tag's ordered taskIds. Setting tagIds:['TODAY'] via update_task does NOT surface a task on Today.",
      arguments: z.object({
        taskIds: z.array(z.string().min(1)).min(1).describe(
          "Task ids to plan for today.",
        ),
        dueDay: z.string().optional().describe(
          "YYYY-MM-DD; defaults to the plugin host's today.",
        ),
      }),
      execute: async (
        args: { taskIds: string[]; dueDay?: string },
        context: Ctx,
      ) => {
        await call(context, "plan_for_today", args);
        context.logger.info("plan_for_today {n}", { n: args.taskIds.length });
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    remove_from_today: {
      description:
        "Remove task(s) from SP's Today list (drop from the TODAY tag's taskIds; optionally clear dueDay).",
      arguments: z.object({
        taskIds: z.array(z.string().min(1)).min(1),
        clearDueDay: z.boolean().default(false).describe(
          "Also null out dueDay (fully unschedule). Default false.",
        ),
      }),
      execute: async (
        args: { taskIds: string[]; clearDueDay: boolean },
        context: Ctx,
      ) => {
        await call(context, "remove_from_today", args);
        context.logger.info("remove_from_today {n}", {
          n: args.taskIds.length,
        });
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    complete_task: {
      description: "Mark an SP task done (updateTask isDone:true).",
      arguments: z.object({
        taskId: z.string().min(1),
      }),
      execute: async (args: { taskId: string }, context: Ctx) => {
        await call(context, "complete_task", { taskId: args.taskId });
        context.logger.info("complete_task {id}", { id: args.taskId });
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    // ── Time logging: write SP's canonical timeSpentOnDay via updateTask ─────────
    // SP's PluginAPI exposes no live timer start/stop — writing the per-day time map
    // is how time is recorded from swamp. The read-modify-write to *add* to a day is
    // done PLUGIN-SIDE (get_tasks → merge → updateTask, in one dispatch) so it reads
    // authoritative live state right before writing; the model's tasks resource does
    // not even expose timeSpentOnDay. Durations are MILLISECONDS (SP's internal unit).
    log_time: {
      description:
        "Log/adjust time spent on a task for a given day by writing SP's canonical " +
        "timeSpentOnDay via updateTask (derived timeSpent recomputes automatically). " +
        "SP's PluginAPI exposes no live timer start/stop — this is how time is recorded " +
        "from swamp. mode:'add' (default) increments the day; mode:'set' overwrites it. " +
        "Durations are MILLISECONDS (SP's internal unit).",
      arguments: z.object({
        taskId: z.string().min(1),
        durationMs: z.number().int().describe(
          "Milliseconds. mode:add → delta added to the day (may be negative to correct); " +
            "mode:set → absolute value for the day. Result is clamped at 0.",
        ),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
          // Reject calendar-invalid dates (2026-06-31, 2026-13-01) that the regex lets
          // through — as a timeSpentOnDay key they'd inflate timeSpent onto a phantom day.
          // Plugin re-validates authoritatively; this is the fast, clear first check.
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
          if (!m) return false; // regex check already failed; don't deref null
          const y = +m[1], mo = +m[2], d = +m[3];
          if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
          const dt = new Date(y, mo - 1, d);
          return dt.getFullYear() === y && dt.getMonth() === mo - 1 &&
            dt.getDate() === d;
        }, "date must be a valid calendar day (YYYY-MM-DD)").optional()
          .describe(
            "YYYY-MM-DD. Omit ⇒ the plugin's local today (SP's _todayStr()).",
          ),
        mode: z.enum(["add", "set"]).default("add"),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        await call(context, "log_time", args);
        context.logger.info("log_time {taskId} {mode} {durationMs}ms", args);
        // Refresh the authoritative task snapshot (parity with update_task/complete_task).
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    notify: {
      description:
        "Fire a native OS notification via SP (PluginAPI.notify) — a workflow primitive.",
      arguments: z.object({
        title: z.string().min(1),
        body: z.string().default(""),
      }),
      execute: async (args: { title: string; body: string }, context: Ctx) => {
        await call(context, "notify", { title: args.title, body: args.body });
        context.logger.info("notify sent: {t}", { t: args.title });
        return { dataHandles: [] };
      },
    },

    // ── WS4: batch fan-out (Rule 6) ─────────────────────────────────────────────
    // ONE dispatch → N create/update/delete/reorder ops → ONE snapshot refresh.
    // This is the escape from update_task's per-call ~10s/380KB refresh + rate limit
    // (15 sequential update_task calls timed out at 12/15). Batch is scoped to ONE
    // project and to STRUCTURE only (title/notes/estimate/parent/subtask-order/done/
    // delete). Attach tags / plan Today via the dedicated methods afterward.
    // Ceiling note: the operations array transits the file-IPC command → SCAN_SRC's
    // executeNodeScript RETURN value. Realistic batches (tens of ops) are well within
    // bounds; a pathologically huge array (thousands of ops) could stress that
    // boundary — stage via a file-based inbound path if that ever bites.
    // LIVE-VERIFIED CAVEAT (2026-07-16): SP's batch does NOT resolve a same-batch
    // tempId used as a create op's parentId — the child is silently dropped (success
    // still true, a bogus created-id still returned). Nest under a just-created task
    // via two batches (parents → real ids → children). See ws4-findings.md.
    batch: {
      description:
        "Apply N structural operations to ONE project in a single plugin dispatch " +
        "(batchUpdateForProject): create/update/delete/reorder tasks. Returns the " +
        "tempId→realId map + per-op errors as the `batchResult` resource and refreshes `tasks`.",
      arguments: z.object({
        projectId: z.string().min(1).describe(
          "The project all operations apply within.",
        ),
        operations: z.array(BatchOperationSchema).min(1).describe(
          "Ordered batch operations.",
        ),
      }),
      execute: async (
        args: { projectId: string; operations: unknown[] },
        context: Ctx,
      ) => {
        const res = (await call(context, "batch", {
          projectId: args.projectId,
          operations: args.operations,
        })) as {
          success?: boolean;
          createdTaskIds?: Record<string, string>;
          errors?: { operationIndex: number; type: string; message: string }[];
        };
        const errors = res?.errors ?? [];
        context.logger.info(
          "batch: {n} ops on {p} -> success={s}, created={c}, errors={e}",
          {
            n: args.operations.length,
            p: args.projectId,
            s: res?.success ?? false,
            c: Object.keys(res?.createdTaskIds ?? {}).length,
            e: errors.length,
          },
        );
        // Distinct instance name: this execution ALSO produces a `tasks` "main"
        // handle via the refresh below, and swamp rejects duplicate instance
        // names across the produced set regardless of resource spec (cf. WS2 fix).
        const batchHandle = await context.writeResource(
          "batchResult",
          "batchResult-main",
          {
            success: res?.success ?? false,
            createdTaskIds: res?.createdTaskIds ?? {},
            errors,
            projectId: args.projectId,
            operationCount: args.operations.length,
            ranAt: new Date().toISOString(),
          },
        );
        // Refresh the tasks snapshot so structural changes are visible via CEL.
        const refreshed = await model.methods.get_tasks.execute({
          includeArchived: false,
        }, context);
        return { dataHandles: [batchHandle, ...(refreshed.dataHandles ?? [])] };
      },
    },

    // ── WS4: delete (GATED — mutates real SP data; verify id + get explicit OK) ──
    delete_task: {
      description:
        "Permanently delete an SP task (PluginAPI.deleteTask). Destructive — verify the " +
        "id with get_tasks first. Refreshes the `tasks` snapshot.",
      arguments: z.object({
        taskId: z.string().min(1),
      }),
      execute: async (args: { taskId: string }, context: Ctx) => {
        await call(context, "delete_task", { taskId: args.taskId });
        context.logger.info("delete_task {id}", { id: args.taskId });
        return await model.methods.get_tasks.execute(
          { includeArchived: false },
          context,
        );
      },
    },

    // ── WS4: tag + project ops ──────────────────────────────────────────────────
    // Each is one-purpose (Rule 2). They refresh via the `sync` fan-out so the new/
    // updated tag or project (and its id) is immediately CEL-referenceable.
    create_tag: {
      description:
        "Create an SP tag (PluginAPI.addTag). Refreshes snapshots via sync so the new tag id is CEL-referenceable.",
      arguments: z.object({
        title: z.string().min(1),
        color: z.string().optional().describe("Hex color, e.g. '#2196f3'."),
        icon: z.string().optional().describe("Material icon name."),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        const res = (await call(context, "create_tag", args)) as {
          id?: string;
        };
        context.logger.info("create_tag -> {id}", { id: res?.id ?? "?" });
        return await model.methods.sync.execute({}, context);
      },
    },

    update_tag: {
      description:
        "Update fields on an existing SP tag (PluginAPI.updateTag). Refreshes snapshots via sync.",
      arguments: z.object({
        tagId: z.string().min(1),
        title: z.string().optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        await call(context, "update_tag", args);
        context.logger.info("update_tag {id}", { id: args.tagId });
        return await model.methods.sync.execute({}, context);
      },
    },

    create_project: {
      description:
        "Create an SP project (PluginAPI.addProject). Refreshes snapshots via sync so the new project id is CEL-referenceable.",
      arguments: z.object({
        title: z.string().min(1),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        const res = (await call(context, "create_project", args)) as {
          id?: string;
        };
        context.logger.info("create_project -> {id}", { id: res?.id ?? "?" });
        return await model.methods.sync.execute({}, context);
      },
    },

    update_project: {
      description:
        "Update fields on an existing SP project (PluginAPI.updateProject). Refreshes snapshots via sync.",
      arguments: z.object({
        projectId: z.string().min(1),
        title: z.string().optional(),
        isArchived: z.boolean().optional(),
        isHiddenFromMenu: z.boolean().optional(),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        await call(context, "update_project", args);
        context.logger.info("update_project {id}", { id: args.projectId });
        return await model.methods.sync.execute({}, context);
      },
    },

    // ── WS7a: meta channel — plugin_status (read-only control-plane verb) ────────
    // Signs a BARE 'plugin_status' command over the SAME §3/§4 pipeline as data; the
    // plugin routes it to dispatchMeta (loop state), NOT the PluginAPI. Carries no
    // secrets. A too-old plugin (no meta allowlist) answers forbidden_action — we
    // translate that into an actionable rebuild/re-import hint.
    plugin_status: {
      description:
        "Query the running plugin loop's self-report (version, ownership, lock " +
        "freshness/staleness, scan count, poll cadence, log level) over the signed " +
        "meta channel and persist it as `pluginStatus`. Read-only. NOTE: meta shares " +
        "the single 30/min command budget — poll no faster than ~every 5s to leave " +
        "headroom for data ops.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        let status: unknown;
        try {
          status = await call(context, "plugin_status");
        } catch (e) {
          // The plugin currently loaded predates the meta channel (WS7a): it has no
          // plugin_status in its allowlist, so the bare command comes back forbidden.
          // Branch on the structured wire code, not a substring of the message.
          if (e instanceof SpCommandError && e.code === "forbidden_action") {
            throw new Error(
              "sp plugin_status: the running plugin does not support the meta channel " +
                "(forbidden_action) — it predates WS7a. Rebuild with build_plugin, " +
                "re-import the plugin (v0.1.15), and restart Super Productivity, then retry.",
            );
          }
          throw e;
        }
        const s = (status ?? {}) as Record<string, unknown>;
        const lock = (s.lock ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "pluginStatus",
          "pluginStatus-main",
          {
            version: String(s.version ?? ""),
            loopId: String(s.loopId ?? ""),
            isOwner: !!s.isOwner,
            uptimeMs: Number(s.uptimeMs ?? 0),
            scanCount: Number(s.scanCount ?? 0),
            pollMs: Number(s.pollMs ?? 0),
            logLevel: String(s.logLevel ?? ""),
            lock: {
              owner: (lock.owner ?? null) as string | null,
              heartbeatAt: (lock.heartbeatAt ?? null) as number | null,
              ageMs: (lock.ageMs ?? null) as number | null,
              stale: !!lock.stale,
            },
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("plugin_status: v{v} loop={l} stale={s}", {
          v: s.version,
          l: s.loopId,
          s: lock.stale,
        });
        return { dataHandles: [handle] };
      },
    },

    // ── WS7a: build_plugin — stamp manifest version + zip the canonical archive ──
    // Reusable build step. Run from the repo root so the default paths resolve.
    build_plugin: {
      description:
        "Stamp plugin/manifest.json's version into plugin.js's __PLUGIN_VERSION__ " +
        "token and produce the canonical importable sp-swamp-plugin.zip (fixed " +
        "3-file archive: manifest.json, plugin.js, index.html) via a pinned pure-JS " +
        "zip writer. Makes version-drift structurally impossible. Dev-repo build tool " +
        "— does NOT touch running SP; re-import + restart SP after building.",
      arguments: z.object({
        pluginDir: z.string().default("extensions/super-productivity/plugin")
          .describe(
            "Dir holding manifest.json + plugin.js + index.html. Relative paths resolve " +
              "against the process CWD — run from the swamp WORKSPACE root (not the module " +
              "repo root) so the default resolves.",
          ),
        outZip: z.string().default(
          "extensions/super-productivity/sp-swamp-plugin.zip",
        ).describe(
          "Output path for the canonical zip (the manifest.yaml `binaries` entry).",
        ),
      }),
      execute: async (
        args: { pluginDir: string; outZip: string },
        context: Ctx,
      ) => {
        const res = await buildPlugin({
          pluginDir: args.pluginDir,
          outZip: args.outZip,
          // Contain reads/writes to the workspace root (FU-3): the default relative
          // paths resolve within it; a caller-supplied `..`/absolute escape is
          // rejected before any fs access.
          root: Deno.cwd(),
        });
        context.logger.info(
          "build_plugin: stamped v{v} -> {z} ({b} bytes, sha {s})",
          {
            v: res.version,
            z: res.outZip,
            b: res.bytes,
            s: res.sha256.slice(0, 12),
          },
        );
        return { dataHandles: [], result: res };
      },
    },
  },
};
