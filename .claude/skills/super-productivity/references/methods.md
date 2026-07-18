# Method surface — what to call and when

Run every method with `swamp model method run sp <method> [--arg k=v ...]`.
Confirm exact argument shapes with `swamp model type describe
@kneel/super-productivity --json`. Durations are **milliseconds**.

## Reads (produce CEL-referenceable snapshots)

| Method | Use when | Notes |
| --- | --- | --- |
| `sync` | You need a fresh view of everything | **Rule-6 fan-out**: ONE execution pulls tasks+projects+tags and writes `tasks-main`, `projects-main`, `tags-main` as separate resources (avoids per-model lock contention — prefer over three separate reads). |
| `get_tasks` | Only tasks needed | `includeArchived` optional; privacy-filtered (excludeTags stripped). Writes `tasks-main`. |
| `get_current_task` | The currently-selected task | Writes `currentTask-main` (or null). |
| `get_worklog` | Time-tracking / worklog view | Writes `worklog-main`. |
| `plugin_status` | Health/ownership/version of the running loop | Meta channel; read-only. Writes `pluginStatus-main`. Shares the 30/min budget — poll ≤ ~every 5s. |

## Writes (mutate SP, then refresh `tasks-main`)

| Method | Use when | Key args |
| --- | --- | --- |
| `create_task` | Add one task | `title` (required); `projectId`, `tagIds`, `notes`, `timeEstimate` (ms), `addToToday`, `dueDay`; `parentId` for a **single** subtask (inherits parent project/tags — projectId/tagIds ignored). For N subtasks at once use `batch`. |
| `update_task` | Patch fields on a task | `taskId` (required); `title`/`notes`/`projectId`/`tagIds`/`timeEstimate`/`isDone`/`dueDay`. `tagIds:['TODAY']` is auto-routed to the Today mechanism. |
| `complete_task` | Mark done | `taskId`. |
| `log_time` | Record/adjust time on a day | `taskId`, `durationMs` (**ms**, may be negative in `add` mode); `date` (YYYY-MM-DD, omit ⇒ plugin's today); `mode` `add` (default, increments) or `set` (overwrites). SP has no live timer start/stop — this writes canonical `timeSpentOnDay`; child→parent rollup is automatic. |
| `plan_for_today` | Put task(s) on the Today page | `taskIds` (≥1), `dueDay` optional. Uses SP's REAL Today mechanism (dueDay + TODAY tag order) — `tagIds:['TODAY']` alone does NOT surface a task on Today. |
| `remove_from_today` | Take task(s) off Today | `taskIds` (≥1), `clearDueDay` to also unschedule. |
| `batch` | Many structural edits to ONE project | `projectId`, `operations[]` (create/update/delete/reorder). ONE dispatch → returns `batchResult` (tempId→realId + per-op errors). Escapes the per-call refresh/rate-limit cost. STRUCTURE only — attach tags / plan Today afterward with the dedicated methods. |
| `delete_task` | Permanently delete | `taskId`. **Destructive** — `swamp model get sp --json` / verify the id first. |
| `notify` | Fire a native OS notification | `title`, `body`. Workflow primitive; writes no resource. |

## Structure (tags/projects)

| Method | Use when |
| --- | --- |
| `create_tag` / `update_tag` | Create or edit tags |
| `create_project` / `update_project` | Create or edit projects |

## Build/dev (does NOT touch running SP)

| Method | Use when |
| --- | --- |
| `provision` | Write the plugin's `0600 .auth_token` from the vault (see [setup.md](setup.md)). Idempotent. |
| `build_plugin` | Stamp `manifest.json`'s version into the artifact and produce the canonical `sp-swamp-plugin.zip` (see [build.md](build.md)). Paths are contained to the workspace root. |

## Chaining with CEL

Once a method has written a resource, reference it — do not re-fetch:

```
data.latest("sp", "tasks-main").attributes.tasks
data.latest("sp", "batchResult").attributes.createdTaskIds
data.latest("sp", "pluginStatus-main").attributes.lock.stale
```
