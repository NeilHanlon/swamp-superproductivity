# Gotchas — non-obvious behavior that will bite you

These are live-verified quirks of SP + the bridge. Ignore them and writes will
silently no-op or land on the wrong day.

## Durations are MILLISECONDS

`timeEstimate`, `durationMs`, and every duration on the wire are SP's internal
unit: **milliseconds**. 25 minutes = `1500000`. `log_time` in `add` mode accepts
a negative `durationMs` to correct an over-log (result clamps at 0).

## "Today" is dueDay + the TODAY tag's order — NOT task.tagIds

SP models the Today page as `task.dueDay` **plus** the `TODAY` tag's ordered
`taskIds` (see SP's `handlePlanTasksForToday`). Setting `tagIds:['TODAY']` via
`update_task` does **not** make a task appear on Today. Use `plan_for_today` /
`remove_from_today`, or `create_task` with `addToToday:true`. (`update_task` does
auto-route a literal `TODAY` in `tagIds` to the real mechanism, but prefer the
dedicated methods.)

## `batch` does NOT resolve a same-batch tempId used as a parentId

Within one `batch`, a create op's `parentId` pointing at another op's `tempId` is
**silently dropped** — the child never gets created, yet the batch still reports
`success:true` and returns a bogus created-id. To nest under a just-created task,
use the **two-batch pattern**: batch 1 creates the parents → read their real ids
from `batchResult.createdTaskIds` → batch 2 creates the children with those real
ids as `parentId`. (Single-subtask creation via `create_task`'s `parentId` is
fine — that targets an already-existing parent.)

## One 30/min command budget, shared by data AND meta

Every command — reads, writes, and `plugin_status` — draws from a single 30/min
budget. The plugin **rejects (never defers)** an over-budget command; the model
retries a signed `rate_limited` with a NEW id + fresh ts. Poll `plugin_status` no
faster than ~every 5s to leave headroom for real work. Prefer `sync` (one fan-out
call) over three separate reads; prefer `batch` over N sequential `update_task`s
(≈10s/380KB refresh each — 15 sequential updates timed out at 12/15).

## Snapshots are short-lived

`tasks`/`projects`/`tags`/`currentTask`/`worklog`/`pluginStatus` have a 5-minute
lifetime. Treat anything older than ~5m as stale and re-`sync`. Always address
CEL by the canonical `-main` instance (`data.latest("sp", "tasks-main")`) — the
instance suffix is not optional.

## The plugin holds a single-writer lock

Only the loop that owns `.bridge_lock` answers. `plugin_status.isOwner` +
`lock.stale` tell you whether the live loop is the owner and whether the lock is
fresh. A stale lock usually means SP was closed/reopened without the loop
re-acquiring — restart SP.

## Errors carry a structured `.code`

A signed error response surfaces as an `SpCommandError` whose `.code` is the
frozen wire code (e.g. `forbidden_action`, `rate_limited`). Branch on `err.code`,
not on substrings of the message. A `forbidden_action` from `plugin_status` means
the running plugin predates the meta channel → rebuild + re-import + restart.

## Build vs. model edits — what needs a restart

- Editing the model TypeScript (`super_productivity.ts`) takes effect on the next
  `swamp model method run` immediately — no re-import.
- Editing **plugin code** (`plugin/plugin.js` etc.) requires `build_plugin` →
  re-import the zip → **restart SP**. Bump `plugin/manifest.json`'s version on
  every plugin-code change (the artifact is version-stamped; see [build.md](build.md)).
