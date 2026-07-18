# WS7 post-ship follow-ups — design draft

Review-driven follow-ups surfaced by WS7a's two-lens adversarial review (0 blocking
findings). SP tracking: parent **`[WS7-FU]`** (`5-Jt7EtwSgtdybfcAPFZD`) under the
"Build @kneel/super-productivity swamp extension" epic. These are **independent** —
a fresh agent can take them in parallel with WS7b/WS7c.

**Not here (already tracked):** debug/`logLevel` gating → **WS7b** (`set_log_level`);
stable promotion → "Promote beta → stable" (`wDx1rhb7…`).

**Ground rules (unchanged from WS7a):** `sp_wire.ts` §3/§4 is FROZEN; plugin.js
SCAN_SRC verify order is locked; keep plugin.js ⇔ `sp_plugin_core.ts` in lockstep
(the parity + case-label tests enforce it); Deno at `~/.swamp/deno/deno`; do **not**
`swamp extension push` without Neil's review. Run tests with
`~/.swamp/deno/deno test extensions/super-productivity/*_test.ts --allow-read --allow-write`.

---

## FU-1 — Declare a proper `swamp` skill packaged with the extension  (`iE2juhQR3kXkTt1hNl9Bi`)

**Why.** Other `@swamp/*` extensions ship a skill that swamp surfaces to agents;
`@kneel/super-productivity` ships none, so an agent using the `sp` model gets no
guidance and rediscovers the bridge/setup/gotchas each time.

**Design.**
- Add a skill directory in the module (e.g. `skill/` with `SKILL.md` +
  `references/`). Wire it into `manifest.yaml` via a `skills:` entry (mirror the
  layout of an existing `@swamp/*` extension that ships a skill — inspect one under
  `~/.swamp/.../skills` or a pulled extension for the exact manifest key + on-disk
  shape before writing).
- `SKILL.md` scope (keep it a router; push detail into `references/`):
  - **Setup:** vault the `{secret,instance}`, `swamp model create … --global-arg
    authSecret=… authInstance=…`, `provision`, import `sp-swamp-plugin.zip`, enable,
    **restart SP**.
  - **Model mental model:** the signed file-IPC bridge (model = server half); reads
    vs writes; resources are CEL-referenceable (`data.latest("sp","tasks-main")…`).
  - **Method surface + when to use each** (`sync` fan-out, `get_*`, `create_task`
    incl. `parentId` subtasks + `addToToday`, `update_task`, `complete_task`,
    `log_time`, `plan_for_today`/`remove_from_today`, `batch`, `delete_task`,
    tag/project ops, `plugin_status`, `build_plugin`).
  - **Build/upgrade flow:** `build_plugin` → re-import → **restart SP**; model `.ts`
    edits are live immediately, plugin-code changes need re-import+restart.
  - **Gotchas:** durations are **milliseconds**; "Today" is `dueDay` + the `TODAY`
    tag's ordered `taskIds` (NOT `task.tagIds`); `batch` does **not** resolve a
    same-batch `tempId` used as a `parentId` (two-batch pattern); meta shares the
    30/min budget (poll `plugin_status` ≤ ~every 5s).
- Keep examples placeholder-only (published-surface hygiene).

**Acceptance.** `swamp extension push … --dry-run` lists the skill under `skills:`;
the skill loads and reads coherently; no new push warnings.

---

## FU-2 — `sendCommand` structured error codes (drop substring matching)  (`9JtubTBmB7FpzptrIIXK5`)

**Why.** `plugin_status` detects an old plugin by `msg.includes("forbidden_action")`
on the JSON-stringified `sendCommand` throw (`super_productivity.ts` ~L1103).
Fragile, and every WS7b/WS7c meta verb will need the same check.

**Design.**
- Keep the frozen **wire** error `code`s unchanged (contract). Change only how the
  **model seam** surfaces them: on a signed error response, throw a typed error that
  carries the structured `code` (e.g. a small `SpCommandError extends Error` with a
  `code: string` field, or attach `err.code`), instead of only embedding it in the
  message string.
- Migrate callers to switch on `err.code === "forbidden_action"` (etc.). Update the
  `plugin_status` old-plugin hint to use the field.
- Preserve the existing thrown-message text for humans; only ADD the structured
  field so nothing downstream that logs the message regresses.

**Files.** `super_productivity.ts` (`sendCommand`, `plugin_status`). **Tests.** Add a
`super_productivity_test.ts` case asserting a `forbidden_action` reply yields an error
with `.code === "forbidden_action"` (the fake-bridge harness already exists — see the
`plugin_status.execute` translation test as a template).

**Acceptance.** No caller matches on a substring; the translation test asserts the
structured code; existing error-message behavior unchanged.

---

## FU-3 — `build_plugin` path containment  (`T3Ar_bEqQTQZXnHjFgYwB`)

**Why.** `pluginDir`/`outZip` are plain strings passed to `Deno.readTextFile`/
`writeFile` with no containment (SEC-1, **low** — reviewer: optional/not urgent).
`build_plugin` is a dev-repo tool OUTSIDE the signed-bridge allowlists, so a caller
already holds equivalent local privilege — hence low risk.

**Design.** Resolve `pluginDir`/`outZip` to absolute paths and assert they stay
within an expected root (the module dir / workspace root); reject `..` escapes and
unexpected absolute paths with a clear error **before** any fs access. Keep the
default-path behavior working from the workspace root.

**Files.** `super_productivity.ts` (`buildPlugin`). **Tests.** Add cases: a `..`
escape and an out-of-root absolute path are rejected; the normal in-root build still
succeeds. **Do only if** we ever expose `build_plugin` to less-trusted callers —
otherwise low priority.

---

## FU-4 — Resolve recurring `credentials-secrets` scanner false-positives  (`kYQDQsK-9lnnX6_rNCjep`)

**Why.** Every `swamp extension push --dry-run` emits two **non-blocking** medium
warnings: `authTokenPath` (a filesystem **path**) and `secret: z.string().min(1)`
(the `AuthRecordSchema` **structural** field) flagged as "looks like a secret." Both
are false positives — the real secret (`authSecret`) is vaulted and
`.meta({sensitive:true})`. The recurring warnings force a manual ack on every push.

**Design (pick one, low priority).**
(a) Restructure/rename so the heuristic stops matching (e.g. rename the local schema
field, or move the token-shape schema so the scanner does not read `secret:` as a
config field) — **without** weakening the real vaulting; or
(b) upstream a scanner allowance/annotation if swamp supports one; or
(c) accept + document as a known false positive (the pragmatic default).

**Acceptance.** A clean `--dry-run` with no manual warning-ack, **or** a documented
decision to accept, recorded in the extension README/docs.

---

### Suggested order for the fresh agent
FU-1 (highest user value, independent) → FU-2 (unblocks cleaner WS7b/WS7c meta-verb
error handling) → FU-4 (quick, or accept) → FU-3 (only if exposure changes).
