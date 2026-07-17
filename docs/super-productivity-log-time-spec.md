# Spec — `log_time` method (@kneel/super-productivity)

**Date:** 2026-07-16
**Author:** design pass (Neil + Claude)
**Status:** approved for implementation — review gate still applies (no `swamp extension push`)
**Ceiling reference:** SP `packages/plugin-api/src/types.ts` (v18.14.0), verified against
`plugin-bridge.service.ts`, `task.service.ts`, `task-shared-crud.reducer.ts`.

## Why this exists (the corrected finding)

WS4 recorded task time as "read-only-internal … blocked by the ceiling." That is
**wrong**, and this method is the correction. Verified write path:

1. `PluginAPI.updateTask(taskId, updates: Partial<Task>)` — `Partial<Task>` includes
   `timeSpentOnDay` (`types.ts:290`). Note `timeSpentOnDay` sits **inside** the
   `// Additional fields for internal use (plugins can read but shouldn't modify)`
   block (comment at `types.ts:289`), so the write depends on an officially
   *discouraged* field. That comment is **advisory only** — `typia` does not enforce
   it — so the write works today. **Forward-compat risk:** if a future SP version
   enforces that boundary, `log_time` breaks; re-verify on SP upgrades.
2. `plugin-bridge.service.ts:888` applies **all** remaining updates unfiltered via
   `_taskService.update(taskId, otherUpdates)` — no field allowlist. Only gate is
   `typia.assert<Partial<TaskCopy>>`, which `timeSpentOnDay` passes.
3. `task.service.ts:511` detects `timeSpentOnDay` in the change set, calls
   `_taskTimeSync.flushOne(id)` (flush pending live-timer ticks so they don't clobber
   the write), then dispatches `TaskSharedActions.updateTask`.
4. `task-shared-crud.reducer.ts:761` runs `updateTimeSpentForTask(...)`, which
   recomputes the **derived** `timeSpent = calcTotalTimeSpent(timeSpentOnDay)`. Same
   code path SP uses for its own time writes.

**Canonical vs derived:** `timeSpentOnDay` (a `{ "YYYY-MM-DD": ms }` map) is canonical;
`timeSpent` is derived and recomputed for you. **Write `timeSpentOnDay`, never
`timeSpent` directly** — a bare `timeSpent` write is not summed and gets clobbered.

**What is still genuinely absent:** a live stopwatch. There is no
`startTimer`/`stopTimer`/`addTimeSpent` in `PluginAPI`. `log_time` writes the *time
data*; it does not drive the running timer. That's the whole ceiling — and it does
not block logging time.

## Blocking constraint: the plugin whitelists update_task fields

The plugin's `update_task` case (`plugin.js:436`) copies only
`["title","notes","projectId","tagIds","timeEstimate","isDone","dueDay"]` into the
patch. A model-only `log_time` that reused action `"update_task"` would have
`timeSpentOnDay` **silently stripped**. Therefore `log_time` **requires a dedicated
plugin command case**, plus an entry in the `ALLOWED` allowlist (`plugin.js:38`).

## Design: plugin-side read-modify-write

`timeSpentOnDay` is a per-day map and the write is absolute (SP overwrites the whole
map). To *add* time to a day you must read the current value, add, and write the merged
map. Do this **in the plugin**, not the model:

- The plugin reads live authoritative state (`PluginAPI.getTasks()`) immediately before
  writing — no stale-snapshot round trip, minimal TOCTOU window.
- The model's `tasks` resource does **not** even expose `timeSpentOnDay`, so a
  model-side RMW would require widening reads. Avoid.

## Method surface (model)

```ts
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
      "mode:set → absolute value for the day. Result is clamped at 0."),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
      "YYYY-MM-DD. Omit ⇒ the plugin's local today (SP's _todayStr())."),
    mode: z.enum(["add", "set"]).default("add"),
  }),
  execute: async (args, context) => {
    await call(context, "log_time", args);
    context.logger.info("log_time {taskId} {mode} {durationMs}ms", args);
    // Refresh the authoritative task snapshot (parity with update_task/complete_task).
    return await model.methods.get_tasks.execute({ includeArchived: false }, context);
  },
}
```

No new resource. Returns the refreshed `tasks` snapshot (instance `main`), same as
`update_task`. `timeSpent` on that snapshot reflects the new total.

## Method surface (plugin) — new `dispatch` case

```js
case "log_time": {
  var date = a.date || _todayStr();
  var all = await PluginAPI.getTasks();          // includes subtasks; excludes archived
  var t = null;
  for (var i = 0; i < all.length; i++) { if (all[i].id === a.taskId) { t = all[i]; break; } }
  if (!t) throw new Error("log_time: task not found (or archived): " + a.taskId);
  var spentOnDay = (t.timeSpentOnDay && typeof t.timeSpentOnDay === "object")
    ? Object.assign({}, t.timeSpentOnDay) : {};
  var prev = +spentOnDay[date] || 0;
  var next = a.mode === "set" ? a.durationMs : prev + a.durationMs;
  if (!isFinite(next)) throw new Error("log_time: non-finite duration");
  if (next < 0) next = 0;                          // negative day-time is invalid
  spentOnDay[date] = next;
  await PluginAPI.updateTask(a.taskId, { timeSpentOnDay: spentOnDay });
  return { taskId: a.taskId, date: date, previousMs: prev, newMs: next, mode: a.mode || "add" };
}
```

Add `"log_time"` to the `ALLOWED` array (`plugin.js:38`).

## Edge cases (implementer must handle; reviewer must check)

1. **Units are milliseconds.** `timeSpentOnDay` values and `durationMs` are ms. Document
   in the arg description; do not accidentally treat as seconds/minutes.
2. **Write `timeSpentOnDay`, not `timeSpent`.** A bare `timeSpent` write is ignored by
   the sum-recompute and lost.
3. **Clamp negatives to 0.** `mode:add` with a large negative delta, or `mode:set` with a
   negative value, must not persist a negative day-time.
4. **Non-finite guard.** Reject `NaN`/`Infinity` (mirrors SP's own `addTimeSpent` guard,
   `task.reducer.ts:216`).
5. **Task not found.** `getTasks()` excludes archived; a missing/archived id throws a
   signed error (fire-and-observe: nothing was mutated). Logging against archived tasks
   is **out of scope for v1** — note it, don't silently no-op.
6. **Live-timer interaction.** When the update carries `timeSpentOnDay`,
   `task.service.ts:511` calls `_taskTimeSync.flushOne(id)` which *commits* any pending
   in-memory timer ticks to state — then our **absolute** overwrite of that day replaces
   them. So ticks accrued between the plugin's `getTasks()` read and the `updateTask`
   write are **clobbered by** our write (not protected from it). The window is short and
   the case is degenerate (manually logging on a task whose timer is concurrently
   running), so accept it — but do not claim flushOne protects the write. A timer that
   keeps running *after* simply accumulates on top of the new baseline.
7. **RMW is plugin-side, single dispatch.** `getTasks()` → `updateTask()` in one command
   handler reads authoritative live state right before writing. Do not move the RMW to
   the model.
8. **`isDone` / other fields untouched.** The patch contains only `timeSpentOnDay`; no
   accidental field carry-over.

## Versioning + gate

- Model `2026.07.16.2` → **`2026.07.16.3`**.
- Plugin `0.1.11` → **`0.1.12`** (`manifest.json` + any version constant), rebuild the
  parent `sp-swamp-plugin.zip`.
- **Gate:** plugin change ⇒ Neil must **re-import AND restart SP** (WS3.5 lock keeps the
  old owner; re-import alone won't swap code) before live verification. **No
  `swamp extension push`** until Neil reviews.

## Tests

- **Plugin core** (`sp_plugin_core_test.ts` harness, if it can stub `PluginAPI`):
  add-to-empty-day; add-to-existing-day (sum); `mode:set` overwrite; negative-clamp;
  default-date path; task-not-found throw; non-finite reject.
- **Model** (`super_productivity_test.ts`): argsSchema accepts the shape; `mode` defaults
  to `"add"`; `call()` invoked with action `"log_time"` and the passed args; bad shapes
  (missing taskId, bad date regex, non-int duration) rejected by Zod.

## Live verification plan (post re-import + restart)

1. `swamp model @kneel/super-productivity method run get_tasks sp` → pick a throwaway
   task id, note its `timeSpent`.
2. `log_time taskId=<id> durationMs=1500000` (25 min) → confirm refreshed snapshot shows
   `timeSpent` increased by 1500000; check SP UI shows 25m on today.
3. Re-run same `log_time` → `timeSpent` now +3000000 (add accumulates).
4. `log_time taskId=<id> durationMs=600000 mode=set` → day is now exactly 600000.
5. `log_time` on a bogus id → signed error, no mutation.
