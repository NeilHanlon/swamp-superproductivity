---
name: super-productivity
description: >
  Drive the @kneel/super-productivity swamp model — headless task/project/tag
  reads and writes to a running Super Productivity instance over a signed
  file-IPC bridge. Use when the user wants to read SP tasks/projects/tags, create
  or update tasks, log time, plan Today, run batch structural edits, notify from a
  workflow, or set up/inspect the bridge plugin. Triggers on "super productivity",
  "SP task", "log time", "plan for today", the `sp` model, "super-productivity
  bridge/plugin", or CEL over `tasks-main`/`projects-main`/`tags-main`.
---

# @kneel/super-productivity

Makes [Super Productivity](https://super-productivity.com/) (SP) a node in the
swamp automation graph. The model is the **server half** of a signed file-IPC
bridge to a first-party SP plugin: an ephemeral `swamp model method run` writes a
signed command file and polls for the signed response; the long-lived plugin
(single-writer `.bridge_lock`) verifies-before-parse and answers. SP's task,
project, and tag state become CEL-referenceable swamp resources.

This skill is a **router** — read the matching reference file for detail. Do not
answer SP-bridge questions from memory; the wire contract and gotchas are exact.

## Prerequisites

- The `sp` model exists (`swamp model get sp --json` to confirm) and its
  `authSecret`/`authInstance` global-args resolve from a vault.
- Super Productivity is running with the bridge plugin imported + enabled.
- Use the installed `swamp` binary from `$PATH` (never `deno run`). Durations are
  **milliseconds**. Meta + data commands share ONE 30/min budget.

## Route by intent

| Intent | Read |
| --- | --- |
| First-time setup: vault → create → provision → import plugin → enable → restart | [references/setup.md](references/setup.md) |
| Which method to call and its arguments (read/write/structure/meta) | [references/methods.md](references/methods.md) |
| Non-obvious behavior that will bite you (Today, batch tempId, ms, budget, staleness) | [references/gotchas.md](references/gotchas.md) |
| Build/upgrade the plugin artifact after a plugin-code change | [references/build.md](references/build.md) |

## Mental model (one paragraph)

The model instance ↔ ONE SP bridge directory (`dataDir`). Reads
(`get_tasks`/`get_current_task`/`get_worklog`) and the fan-out `sync` write
CEL-referenceable resources; writes (`create_task`, `update_task`,
`complete_task`, `log_time`, `plan_for_today`, `batch`, …) mutate SP and refresh
the `tasks` snapshot. Reference the data with CEL — prefer
`data.latest("sp", "tasks-main").attributes.tasks` over the deprecated
`model.…resource.…` form. The `-main` instance suffix is mandatory: every
producer writes the single canonical instance (`tasks-main`, `projects-main`,
`tags-main`, `currentTask-main`, `worklog-main`, `pluginStatus-main`).

## Common first steps

```bash
swamp model get sp --json                         # confirm the model + globals
swamp model method run sp plugin_status           # is the plugin loop alive/owner?
swamp model method run sp sync                     # refresh tasks/projects/tags
swamp data get sp --json                           # inspect the latest snapshots
```

If `plugin_status` throws a `forbidden_action`/meta-channel hint, the running
plugin predates the meta channel — rebuild + re-import + restart SP
(see [references/build.md](references/build.md)).
