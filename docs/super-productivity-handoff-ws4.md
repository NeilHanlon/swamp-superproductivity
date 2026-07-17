# Handoff: WS4 — breadth (batch / delete / tag+project ops / time-tracking probe)

**Date:** 2026-07-16
**State:** WS3.5 (single-writer `.bridge_lock`) COMPLETE + live-verified. WS4
today-planning slice DONE (plugin v0.1.10). This handoff is the REST of WS4:
the batch fan-out, delete, tag/project ops, trigger_sync, and the time-tracking
feasibility probe.

---

## Read first (in order)

1. `~/.claude/projects/-home-neil-dev-swamp/memory/superproductivity-swamp-extension.md`
   — full state. Read the top Status block (WS3.5) AND the "WS4 slice —
   Today-planning" section (the today-planning learnings: Today = `dueDay` +
   `Tag('TODAY').taskIds`, NOT `task.tagIds`; subtask→parent anchoring).
2. `~/.claude/projects/-home-neil-dev-swamp/memory/keep-sp-tasks-updated.md`
   — standing instruction: close/track SP tasks via the `sp` model as work lands.
3. `~/dev/swamp/extensions/docs/super-productivity-plan.md` — §3/§4 LOCKED (wire +
   hardened protocol); §5 WS4 scope; §4 addendum item 12 (single-writer, now done).
4. The `swamp` skill.

## Where we are

- Plugin **v0.1.10** live in SP (WS3.5 lock + today-planning). Model type
  **v2026.07.16.1**. Neither pushed to the registry (review gate).
- Canonical zip: `extensions/super-productivity/sp-swamp-plugin.zip` (PARENT dir).
  Build: `cd extensions/super-productivity && zip -j sp-swamp-plugin.zip plugin/manifest.json plugin/plugin.js plugin/index.html`.
- **Debug instrumentation is still ON** (`dbgAppend` + `_debug_*.log`). Leave it —
  cleanup (strip to next free version, 0.1.11+) is deferred until WS4 stabilizes.
- Model methods today: `provision, sync, get_tasks, get_current_task, get_worklog,
  create_task, update_task, plan_for_today, remove_from_today, complete_task, notify`.

## WS4 work — the PluginAPI ceiling is confirmed (SP `packages/plugin-api/src/types.ts`)

Priority order:

### 1. `batch` — wrap `batchUpdateForProject` (DO THIS FIRST; Rule 6 fan-out)
This is the single most valuable WS4 method. Today-planning already hit the wall:
`update_task` refreshes the FULL ~380KB task snapshot each call (~10s) and
`MAX_PER_MIN=30` rate-limits — 15 sequential edits timed out at 12/15. `batch` does
N operations in ONE plugin dispatch → ONE snapshot refresh → one rate-limit tick.
- API: `batchUpdateForProject({projectId, operations: BatchOperation[]}) → {success, createdTaskIds:{tempId:realId}, errors[]}`.
- `BatchOperation` union: `{type:'create', tempId, data:{title,notes?,isDone?,parentId?,timeEstimate?}}`
  | `{type:'update', taskId, updates:{title?,notes?,isDone?,parentId?,timeEstimate?,subTaskIds?}}`
  | `{type:'delete', taskId}` | `{type:'reorder', taskIds:[]}`.
  Note: batch `create`/`update` do NOT include tagIds/dueDay/projectId — those go
  through `create_task`/`update_task`/`plan_for_today`. Batch is for structure
  (title/notes/estimate/parent/subtask-order/done/delete) within ONE project.
- Model method shape: `batch(projectId, operations)` → return `createdTaskIds` + any
  `errors` (surface `operationIndex`/`type`/`message`). Add `batch` to plugin
  `ALLOWED` + a dispatch case. Watch payload size — a big operations array as args
  may hit **E2BIG** on the spawn path; if so, stage the request via a file like
  `_pending_results.json` (fs/path/os-only staging script → direct-exec path).

### 2. `delete_task` — wrap `deleteTask(taskId)`
Simple. SP task `[WS4] UxwFGMhEPAhp5PtRt0kk1` explicitly wants it. **GATE:** deletes
SP data — verify id first (`get_tasks`) and get Neil's OK before running live.

### 3. Tag + project ops
- `create_tag` → `addTag(Partial<Tag>)`; `update_tag` → `updateTag(id, updates)`
  (already used internally by `planForToday` for `TODAY.taskIds`).
- `create_project` → `addProject(Partial<Project>)`; `update_project` → `updateProject(id, updates)`.
- Keep each method one-purpose (Rule 2). Reads already exist via `get_snapshot`
  (`getAllProjects`/`getAllTags`).

### 4. `trigger_sync`
Confirm the PluginAPI surface first — grep `plugin-api/src/types.ts` for a sync
trigger (e.g. `triggerSync`/`sync`). If none, `trigger_sync` may not be reachable
from a plugin; document that and drop it, or route via a different capability.

### 5. Counters / time-tracking — FEASIBILITY PROBE, likely BLOCKED
`Task.timeSpent` / `timeSpentOnDay` are read-only-internal in PluginAPI; there is
NO timer/log-time write method. Confirm against `types.ts`; if truly absent,
document time-tracking as **not-supported-by-ceiling** (a WS4 non-goal / upstream
ask), don't fake it. `get_worklog` (read) already exists.

## How to build/verify each method

- Core logic goes in the TS modules if it's protocol-shaped; the model
  (`extensions/models/super_productivity.ts`) adds the method + argsSchema; the
  plugin (`plugin/plugin.js`) adds `ALLOWED` entry + `dispatch` case. Keep the
  three in lockstep (plugin is the codegen target of `sp_wire.ts`/`sp_plugin_core.ts`).
- Unit: `~/.swamp/deno/deno test --no-check extensions/models/*_test.ts --allow-all`.
  `deno check` + `node --check plugin/plugin.js` before every zip.
- Live: `swamp model method run sp <method> --input key=value` (`--input 'k=v'`
  single-quoted preserves spaces; `k:json='<json>'` for typed). Observe via
  `_debug_tick.log`/`_debug_scan.log` (grep by id; count `filesSeen` for scan rate).

## Gates (Neil is the engineer; check in, don't spin)

- **Live-plugin change** (any `plugin.js` edit) → build the PARENT zip; Neil
  re-imports **AND RESTARTS SP**. The WS3.5 lock keeps the original owner, so a
  re-import ALONE does not swap in new code — the old iframe stays owner. Restart
  is now load-bearing.
- **SP-data writes** (create/update/complete/**delete**/batch that mutates tasks):
  pre-authorized for tracking-task hygiene, but anything touching REAL user task
  data (esp. `delete_task`, `batch` deletes) → verify id + get Neil's explicit OK.
- **No `swamp extension push`** until Neil reviews ([[no-push-extensions-without-review]]).
- Close the `[WS4]` tracking task(s) via the `sp` model as slices land.

## Quick reference

- Bridge dir: `~/.var/app/com.super_productivity.SuperProductivity/data/super-productivity-swamp`
- Vault: `super-productivity` (`secret`+`instance`, instance `c864a2dd-8bc0-4fc6-b21e-e3503e3b2d44`)
- Model instance: `sp` (`b59dd413-3ef9-474a-9c8f-b20f5d43785b`); plugin id `kneel-super-productivity-swamp` (v0.1.10)
- SP source ceiling: `~/dev/thirdparty/github.com/johannesjo/super-productivity/packages/plugin-api/src/types.ts` (BatchOperation @ ~805-873, PluginAPI iface @ ~650-680)
- Deno: `~/.swamp/deno/deno` · Adversarial harness: `extensions/models/ws3_adv.ts` · Lock isolation test: `scratchpad/lock_test.js`
- WS4 tracking task: `[WS4] UxwFGMhEPAhp5PtRt0kk1`; parent `cI5Gi13f38jGniqyto0iV` (project `TyxsSbEOd5699ABOeXrDe`)
- Env note (not ours): `super-productivity-mcp` node procs = b0x42's separate MCP/bridge — leave alone.
