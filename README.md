# @kneel/super-productivity

Make [Super Productivity](https://super-productivity.com/) (SP) a node in the
[swamp](https://swamp-club.com) automation graph. This extension exposes SP's
tasks, projects, tags, and time-tracking as CEL-referenceable swamp resources and
lets workflows read and write your task manager over a **signed file-IPC bridge**
to a first-party SP plugin.

It is **not** a reimplementation of the SP-MCP tool surface. The swamp model is
the "server" half of an authenticated bridge; the plugin (shipped in `plugin/`) is
the "client" half running inside SP.

## Why a bridge (and why signed)

SP plugins run in a sandboxed iframe and reach the app through `PluginAPI`. The
existing community MCP bridges talk to SP over an **unauthenticated** file channel.
This extension adds the missing auth layer: every command is an HMAC-signed
envelope bound to a provisioned `instance` id, verified **before** parsing, with
replay dedup, stale-timestamp rejection, and a per-minute budget that is *rejected*
(not deferred) when exceeded.

```
swamp method (ephemeral)                     SP plugin (long-lived, single-writer)
  resolve auth ─┐                             ┌─ poll plugin_commands/
  sign command ─┼─► plugin_commands/<id>.json ┤  verify-before-parse (k_cmd subkey)
  poll response ┘                             │  dedup-on-execute, budget-reject
  verify (k_rsp)◄── plugin_responses/<id>… ◄──┴─ PluginAPI.<call>() → sign response
```

Wire contract and hardening details: `docs/super-productivity-plan.md` (§3/§4).

## Setup

1. **Store the secret.** Create a vault holding the 32-byte HMAC `secret` (hex) and
   the provisioned `instance` uuid.

   ```bash
   swamp vault create local_encryption super-productivity
   # store `secret` (32-byte hex) and `instance` (uuid) keys
   ```

2. **Create the model.** One model instance == one SP bridge (rendezvous) directory.

   ```bash
   swamp model create @kneel/super-productivity sp \
     --global-arg dataDir=/absolute/path/to/super-productivity-swamp \
     --global-arg authSecret='${{ vault.get(super-productivity, secret) }}' \
     --global-arg authInstance='${{ vault.get(super-productivity, instance) }}'
   ```

3. **Provision the plugin's token.**

   ```bash
   swamp model method run sp provision
   ```

4. **Install the plugin.** Import `plugin/sp-swamp-plugin.zip` in Super Productivity
   (Settings → Plugins), enable it, then **restart SP**. Because of the plugin's
   single-writer `.bridge_lock`, a re-import alone will not swap in new plugin code —
   the old owner keeps the lock until SP restarts.

5. **Sync.**

   ```bash
   swamp model method run sp sync
   ```

## Resources

| Resource      | Instance(s)              | Notes                                        |
| ------------- | ------------------------ | -------------------------------------------- |
| `tasks`       | `tasks-main`             | Privacy-filtered task snapshot (5m lifetime) |
| `projects`    | `projects-main`          | Projects snapshot                            |
| `tags`        | `tags-main`              | Tags snapshot                                |
| `currentTask` | `currentTask-main`       | Currently-selected task (or null)            |
| `worklog`     | `worklog-main`           | Time-tracking / worklog snapshot             |
| `batchResult` | `batchResult-main`       | Last `batch` run: tempId→realId + errors     |

Reference with CEL (prefer `data.latest(name, instance)`):

```
data.latest("sp", "tasks-main").attributes.tasks
data.latest("sp", "batchResult-main").attributes.createdTaskIds
```

> **One canonical snapshot:** every producer of the tasks snapshot — `sync`,
> `get_tasks`, and all mutating methods (`create`/`update`/`delete`/`complete`/
> `log_time`/`batch`), which refresh through `get_tasks` — writes the single
> `tasks-main` instance. Read `data.latest("sp", "tasks-main")` after any of them
> and you get the latest state; there is no per-method instance to track.

## Methods

| Method | Purpose |
| --- | --- |
| `provision` | Write the plugin's 0600 token copy from the vault; create bridge dirs. Idempotent. |
| `sync` | Rule-6 fan-out: tasks+projects+tags in one execution → three resources. |
| `get_tasks` / `get_current_task` / `get_worklog` | Reads (privacy-filtered). |
| `create_task` | `addTask`. `parentId` ⇒ single-call subtask (inherits parent project/tags); `addToToday`/`dueDay` for Today. |
| `update_task` / `complete_task` | Patch fields / mark done. |
| `log_time` | Log/adjust time for a day via canonical `timeSpentOnDay` (`mode: add|set`, ms). Child→parent rollup automatic. |
| `plan_for_today` / `remove_from_today` | SP's real Today mechanism (`dueDay` + `TODAY` tag order), subtask→parent anchored. |
| `batch` | One dispatch, N create/update/delete/reorder ops within a project → `batchResult`. |
| `delete_task` | Permanently delete a task. **Destructive** — verify the id first. |
| `create_tag` / `update_tag` / `create_project` / `update_project` | Structure. |
| `notify` | Fire a native OS notification via SP. |

### Time tracking

SP's `PluginAPI` has no live-timer start/stop, but task **time is writable**:
`log_time` writes the canonical `timeSpentOnDay` map (`{ "YYYY-MM-DD": ms }`) through
`updateTask`; SP recomputes the derived `timeSpent` and rolls subtask time up to the
parent automatically — the same path SP's own timer uses.

```bash
# add 25 minutes to today
swamp model method run sp log_time --input taskId=<id> --input durationMs:json=1500000
# set a specific day's total
swamp model method run sp log_time --input taskId=<id> --input durationMs:json=600000 \
  --input mode=set --input date=2026-07-16
```

### Subtasks

`create_task --input parentId=<real task id>` creates a single subtask. To create
many subtasks at once, use `batch` with the parent's **real** id (SP's batch does
not resolve a same-batch `tempId` used as a `parentId` — create parents first, read
the real ids from `createdTaskIds`, then batch the children).

## Fan-out with `batch`

`update_task` refreshes the full task snapshot each call and is rate-limited, so
mutating many tasks in a loop is slow and can hit the per-minute budget. `batch`
applies N structural ops to ONE project in a single dispatch with one refresh:

```bash
swamp model method run sp batch \
  --input projectId=<projectId> \
  --input 'operations:json=[{"type":"create","tempId":"a","data":{"title":"first"}},
                            {"type":"create","tempId":"b","data":{"title":"second"}},
                            {"type":"reorder","taskIds":["b","a"]}]'
```

## Security model

- **HMAC over opaque bytes**, verified before JSON parse; separate `k_cmd`/`k_rsp`
  subkeys derived from the shared secret.
- **Reader-binding**: the authoritative command id is the payload's, not the
  filename; responses are bound to the id that sent the command.
- **Replay dedup** on execute; **stale-timestamp** rejection; **aud (instance)**
  binding so a command minted for one install is dropped by another.
- **Budget-reject, not defer**: over-budget commands get a signed `rate_limited`
  error and retry with a fresh id — never a reused id that would self-collide.
- **Single-writer lock**: only one plugin loop polls the bridge dir; reloaded
  iframes idle as watchers, so plugin reloads don't multiply dedup sets.

## Development

Source is TypeScript checked and tested with swamp's bundled Deno:

```bash
~/.swamp/deno/deno check super_productivity.ts sp_wire.ts sp_plugin_core.ts
~/.swamp/deno/deno test *_test.ts --allow-read --allow-write
```

The plugin (`plugin/plugin.js`) bundles `sp_wire` + `sp_plugin_core` across the
Node-crypto / iframe-`PluginAPI` boundary of SP's `executeNodeScript`. Rebuild the
importable zip after editing the plugin:

```bash
cd plugin && zip -j -X ../sp-swamp-plugin.zip manifest.json plugin.js index.html
```

## License

MIT © 2026 Neil Hanlon. See `LICENSE.txt`.
