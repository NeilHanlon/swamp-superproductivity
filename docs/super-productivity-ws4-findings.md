# WS4 findings — breadth (batch / delete / tag+project / trigger_sync / time-tracking)

**Date:** 2026-07-16
**Plugin:** v0.1.11 · **Model:** `2026.07.16.2` (neither pushed — review gate)
**Ceiling reference:** SP `packages/plugin-api/src/types.ts` (v18.14.0)

## Shipped methods

| Method | PluginAPI call | Notes |
| --- | --- | --- |
| `batch(projectId, operations[])` | `batchUpdateForProject` | Rule-6 fan-out: ONE dispatch, N create/update/delete/reorder ops, ONE refresh. Surfaces `createdTaskIds` (tempId→realId) + per-op `errors` as the **`batchResult`** resource; also refreshes `tasks`. |
| `delete_task(taskId)` | `deleteTask` | **GATED** — destructive; verify id + explicit OK before live. Refreshes `tasks`. |
| `create_tag(title,color?,icon?)` | `addTag` | Refreshes via `sync` so the new tag id is CEL-referenceable. |
| `update_tag(tagId,title?,color?,icon?)` | `updateTag` | Only supplied keys are patched (`_pick`). |
| `create_project(title)` | `addProject` | Refreshes via `sync`. |
| `update_project(projectId,title?,isArchived?,isHiddenFromMenu?)` | `updateProject` | Only supplied keys are patched. |

`batch` is STRUCTURE within ONE project (title/notes/estimate/parent/subtask-order/
done/delete). `tagIds`/`dueDay`/`projectId` are **not** batchable — route those
through `create_task`/`update_task`/`plan_for_today` after the batch.

### batch payload ceiling (documented, not yet hit)
The `operations` array transits: model Deno process → signed command **file** (no
limit) → `SCAN_SRC` `fs.readFileSync` (no limit) → SCAN_SRC's `executeNodeScript`
**return value** back to the iframe → `batchUpdateForProject` (direct iframe call,
no spawn). The E2BIG limit that bit WS2 applies to executeNodeScript **args**
(input), NOT to file reads or the dispatch. So realistic batches (tens of ops) are
safe. A pathological array (thousands of ops) could stress the SCAN return
boundary — if that ever bites, stage the inbound request via a file (the same
`_pending_results.json` pattern used outbound). Not built; not needed yet.

## Live verification (2026-07-16, plugin v0.1.11, after re-import + SP restart)

Full sweep against a throwaway `[WS4 verify]` project. Results:

- ✅ **`create_project` / `update_project`** — created; renamed + `isHiddenFromMenu:true` applied.
- ✅ **`create_tag` / `update_tag`** — created; title + color (`#e91e63`) patched.
- ✅ **`batch` top-level create + reorder** — `success:true`, `createdTaskIds` maps
  every tempId→real id, `errors:[]`.
- ✅ **`delete_task`** — task removed (confirmed absent in a fresh authoritative `sync`).
- ⚠️ **`batch` create-subtask with a same-batch tempId parent** — **SP silently drops
  the child.** Isolated cleanly: `create p` + `create c{parentId:"p"}` → `p` persists
  with EMPTY `subTaskIds`, `c` is never persisted, yet SP returns `success:true` and a
  (bogus) created-id for `c`. Control: `create c2{parentId:<REAL id>}` → persists,
  parent's `subTaskIds` updates. **Conclusion: SP's `batchUpdateForProject` does not
  resolve tempId parent references for `create`.** The wrapper relays SP faithfully;
  fix is the two-phase workaround (parents → read real ids → children). Documented in
  the `batch` argsSchema + method comment. Candidate upstream SP bug report.

### Two gotchas found during verification (not bugs in this extension)

1. **A model-side error AFTER `call()` does not roll back the SP mutation.** The first
   `batch` run failed on a model-side data-validation error (below) but SP had already
   executed the batch — the tasks existed. The bridge is fire-and-observe: the plugin
   commits before the model post-processes. Design accordingly (make the SP call the
   last fallible step, or reconcile via a follow-up read).
2. **Duplicate-instance-name rule spans resource specs.** `batch` first wrote its
   `batchResult` handle AND a `tasks` handle both as instance `"main"` → swamp rejected
   with `Duplicate data instance name 'main'` (same class as WS2's sync fix). Fixed:
   `batchResult` writes instance `"batchResult-main"`. **Follow-up (resolved):** this
   same duplicate-instance rule had earlier forced the `tasks` snapshot to split — `sync`
   wrote `tasks-main` while `get_tasks` (and every mutating method funneling through it)
   wrote `main`, so reads after a `sync` never reflected a subsequent `log_time`/`update`.
   `get_tasks` now also writes **`tasks-main`**, so there is ONE canonical tasks instance
   across every producer; read `data.latest("sp", "tasks-main")` after any method.

## trigger_sync — DROPPED (unreachable from a plugin)

`PluginAPI` (types.ts, interface `PluginAPI` @ ~520–777) exposes **no** sync
trigger — no `triggerSync`, `forceSync`, `sync()`, or equivalent. Sync is a
host/app concern, not a plugin capability. There is nothing to wrap, so
`trigger_sync` is dropped from WS4 scope. If it's ever wanted, it's an upstream
ask (add a plugin-facing sync trigger to PluginAPI), not something the bridge can
route around.

## time-tracking — WRITABLE via `updateTask({timeSpentOnDay})` (finding corrected 2026-07-16)

> **Correction.** The original WS4 verdict ("task time is read-only-internal …
> blocked by the ceiling") was **wrong** — it conflated "no live-timer API" with
> "cannot write time." Re-traced against SP v18.14.0 source, task time **is
> writable** from the plugin. See `super-productivity-log-time-spec.md` for the
> full path and the `log_time` method built on it.

Two different things were conflated under "counters/time-tracking":

- **Task time (`timeSpent` / `timeSpentOnDay`)** — **WRITABLE.**
  `PluginAPI.updateTask(taskId, {timeSpentOnDay})` reaches SP's real time-write
  reducer: the plugin bridge applies updates unfiltered
  (`plugin-bridge.service.ts:888` → `_taskService.update`), `task.service.ts:511`
  flushes live-timer ticks, and `task-shared-crud.reducer.ts:761`
  (`updateTimeSpentForTask`) recomputes the derived `timeSpent` — the same path SP
  uses internally. Canonical field is `timeSpentOnDay` (`{"YYYY-MM-DD": ms}`);
  `timeSpent` is derived, so **write `timeSpentOnDay`, not `timeSpent`**. Exposed
  as the `log_time` method (add/set, plugin-side read-modify-write). `get_worklog`
  (read) already existed. **Only genuinely absent: a live stopwatch** — no
  `startTimer`/`stopTimer`/`addTimeSpent` in PluginAPI. That is an upstream ask and
  does **not** block logging time.
- **Generic named counters** — PluginAPI DOES expose
  `setCounter`/`getCounter`/`incrementCounter`/`decrementCounter`/`deleteCounter`/
  `getAllCounters` (types.ts ~765–776). These are free-standing integer counters
  keyed by an arbitrary id — **not** attached to tasks and **not** task time. They
  could back a swamp `counter` method surface if a use case appears (e.g. a
  workflow tallying events), but they do NOT satisfy time-tracking. Left unbuilt
  pending a concrete need.

## Gate status

Live-plugin change → PARENT zip rebuilt (`sp-swamp-plugin.zip`, v0.1.11). Needs
Neil to **re-import AND restart SP** (WS3.5 lock keeps the old owner; re-import
alone won't swap in new code). Live verification of `batch`/tag/project pending
that restart; `delete_task` live run needs explicit OK on a verified id.
